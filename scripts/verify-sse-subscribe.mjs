#!/usr/bin/env node
// Real end-to-end verification for the SSE subscribe route + LISTEN/NOTIFY transport (Git #4782).
//
// No mocks: this starts the real HTTP server in-process against the REAL Postgres named by
// DATABASE_URL, mints a real bearer token, and drives real SSE connections with fetch. It checks:
//   - both auth forms (Bearer header, path token) on the new route; 401/400/405 edges
//   - a NOTIFY (raw, and via publish()) reaches every subscriber of the channel, verbatim, with no
//     polling; other channels do not leak
//   - a subscriber survives several heartbeat intervals with no server-side data flowing
//   - LISTEN is NOT on the shared pool (the pool sees no listened channels; the listener is its own
//     backend, identified by application_name)
//   - killing the listener's backend (what a Replit recycle looks like) reconnects, sends `resync`,
//     and delivery resumes
//   - the 8000-byte NOTIFY cap: publish() rejects over it and delivers at exactly the limit
//   - a revoked token's open stream is closed
//   - a full transport stop/start (process-restart equivalent) serves a fresh subscriber
//   - client disconnect releases the subscription
//
// Needs DATABASE_URL in the environment (extract it with one grep line; never source .env.local).
// The token it mints is revoked at the end. Exits non-zero on any failure.
//
// Usage: DATABASE_URL=... node scripts/verify-sse-subscribe.mjs

import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { loadEnvLocal } from "../src/env.ts";
import { createMcpHttpServer } from "../src/server.ts";
import { issueToken, revokeToken } from "../src/tokens.ts";
import { query, closePool } from "../src/db.ts";
import {
  closePubSub,
  listenerApplicationName,
  MAX_PAYLOAD_BYTES,
  publish,
  pubsubStats,
  resetPubSubForTests,
  startListener,
} from "../src/pubsub.ts";

loadEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
// Short intervals so the heartbeat and revocation checks are observable in seconds, not minutes.
process.env.GITHUB_MCP_SSE_HEARTBEAT_MS = "400";
process.env.GITHUB_MCP_SSE_TOKEN_RECHECK_MS = "600";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Opens a real SSE connection and records every event / keep-alive comment that arrives. */
async function openStream(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const s = { status: res.status, events: [], comments: 0, closed: false, body: "", abort: () => ctrl.abort() };
  if (res.status !== 200) {
    s.body = await res.text();
    s.closed = true;
    return s;
  }
  s.contentType = res.headers.get("content-type");
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split("\n");
          if (lines.every((l) => l.startsWith(":"))) {
            s.comments += 1;
            continue;
          }
          const ev = lines.find((l) => l.startsWith("event: "));
          if (!ev) continue; // `retry:` preamble
          s.events.push({
            event: ev.slice(7),
            data: lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"),
          });
        }
      }
    } catch {
      // aborted or reset
    }
    s.closed = true;
  })();
  return s;
}

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
const messages = (s) => s.events.filter((e) => e.event === "message").map((e) => e.data);
const has = (s, event) => s.events.some((e) => e.event === event);

async function listenerPid() {
  const { rows } = await query(`SELECT pid FROM pg_stat_activity WHERE application_name = $1`, [
    listenerApplicationName(),
  ]);
  return rows.length === 1 ? rows[0].pid : rows.map((r) => r.pid);
}

const issued = [];
const streams = [];
const track = (s) => (streams.push(s), s);

async function startHttp() {
  const server = createMcpHttpServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const raw = new pg.Client({ connectionString: process.env.DATABASE_URL });
await raw.connect();

try {
  const t1 = await issueToken("verify-sse-4782");
  issued.push(t1);
  const bearer = { authorization: `Bearer ${t1.token}` };

  let { server, base } = await startHttp();
  startListener();

  console.log("\n[1] GET /mcp copy no longer claims there is no SSE stream");
  const describe = await (await fetch(`${base}/mcp`)).json();
  check("note dropped the stale 'does not open an SSE stream' claim", !/does not open an SSE stream/i.test(describe.note), describe.note);
  check("describe advertises the subscribe route", /subscribe/.test(describe.subscribe ?? ""));

  console.log("\n[2] auth + input edges");
  const noTok = await openStream(`${base}/mcp/subscribe/test`);
  check("no token -> 401", noTok.status === 401, `status ${noTok.status}`);
  const badHeader = await openStream(`${base}/mcp/subscribe/test`, { authorization: "Bearer ghmcp_nope" });
  check("bad header token -> 401", badHeader.status === 401, `status ${badHeader.status}`);
  const badPath = await openStream(`${base}/mcp/t/ghmcp_nope/subscribe/test`);
  check("bad path token -> 401", badPath.status === 401, `status ${badPath.status}`);
  const badChan = await openStream(`${base}/mcp/subscribe/bad%20channel!`, bearer);
  check("invalid channel name -> 400", badChan.status === 400, `status ${badChan.status}`);
  const longChan = await openStream(`${base}/mcp/subscribe/${"a".repeat(61)}`, bearer);
  check("61-char channel name -> 400", longChan.status === 400, `status ${longChan.status}`);
  const post = await fetch(`${base}/mcp/subscribe/test`, { method: "POST", headers: bearer });
  check("POST -> 405", post.status === 405, `status ${post.status}`);

  console.log("\n[3] both auth forms subscribe; NOTIFY fans out verbatim, no polling");
  const a = track(await openStream(`${base}/mcp/subscribe/test`, bearer));
  const b = track(await openStream(`${base}/mcp/t/${encodeURIComponent(t1.token)}/subscribe/test`));
  const other = track(await openStream(`${base}/mcp/subscribe/other`, bearer));
  check("header form -> 200 event-stream", a.status === 200 && /text\/event-stream/.test(a.contentType ?? ""), `${a.status} ${a.contentType}`);
  check("path-token form -> 200 event-stream", b.status === 200 && /text\/event-stream/.test(b.contentType ?? ""), `${b.status} ${b.contentType}`);
  check("ready event names the channel", await waitFor(() => has(a, "ready") && has(b, "ready")));
  check("ready payload is the channel", a.events[0]?.data === '{"channel":"test"}', JSON.stringify(a.events[0]));

  await raw.query(`NOTIFY "sg:test", 'hello-raw'`);
  check("raw NOTIFY reaches header subscriber verbatim", await waitFor(() => messages(a).includes("hello-raw")), JSON.stringify(a.events));
  check("raw NOTIFY reaches path-token subscriber verbatim", await waitFor(() => messages(b).includes("hello-raw")), JSON.stringify(b.events));

  await publish("test", { n: 1, id: "abc" });
  check("publish() reaches both subscribers as JSON", await waitFor(() => messages(a).includes('{"n":1,"id":"abc"}') && messages(b).includes('{"n":1,"id":"abc"}')));
  await publish("other", "marker");
  await waitFor(() => messages(other).length > 0);
  check("other channel got only its own message", JSON.stringify(messages(other)) === '["\\"marker\\""]', JSON.stringify(messages(other)));
  check("no cross-channel leak into 'test'", !messages(a).includes('"marker"'));

  console.log("\n[4] heartbeat keeps an idle stream alive");
  const beforeBeats = a.comments;
  await sleep(1300);
  check("idle stream received >=2 keep-alive comments and is still open", a.comments - beforeBeats >= 2 && !a.closed, `beats ${a.comments - beforeBeats}, closed ${a.closed}`);

  console.log("\n[5] LISTEN is on a dedicated connection, not the pool");
  const pooled = await query(`SELECT pg_listening_channels() AS c`);
  check("pool connection listens on nothing", pooled.rows.length === 0, JSON.stringify(pooled.rows));
  const pid1 = await listenerPid();
  check("exactly one dedicated listener backend exists", typeof pid1 === "number", JSON.stringify(pid1));
  const stats = pubsubStats();
  check("stats: connected, 2 channels, 3 subscribers", stats.connected && stats.channels === 2 && stats.subscribers === 3, JSON.stringify(stats));

  console.log("\n[6] listener backend killed (Replit-style drop) -> reconnect + resync + delivery resumes");
  await query(`SELECT pg_terminate_backend($1)`, [pid1]);
  check("subscribers received resync", await waitFor(() => has(a, "resync") && has(b, "resync") && has(other, "resync"), 8000));
  check("streams were NOT dropped by the listener reconnect", !a.closed && !b.closed && !other.closed);
  const pid2 = await listenerPid();
  check("a NEW listener backend replaced the killed one", typeof pid2 === "number" && pid2 !== pid1, `${pid1} -> ${JSON.stringify(pid2)}`);
  await publish("test", { after: "reconnect" });
  check("delivery resumed on both auth forms", await waitFor(() => messages(a).includes('{"after":"reconnect"}') && messages(b).includes('{"after":"reconnect"}')));

  console.log("\n[7] 8000-byte NOTIFY cap");
  const ok = "x".repeat(MAX_PAYLOAD_BYTES - 2); // JSON adds two quote bytes -> exactly the limit
  await publish("test", ok);
  check("payload at exactly the limit is delivered intact", await waitFor(() => messages(a).includes(`"${ok}"`)));
  let rejected = "";
  try {
    await publish("test", ok + "x");
  } catch (e) {
    rejected = e.message;
  }
  check("payload over the limit is rejected with a clear error", /at most 7999/.test(rejected), rejected);
  let badName = "";
  try {
    await publish("bad name", 1);
  } catch (e) {
    badName = e.message;
  }
  check("publish() rejects an invalid channel name", badName.length > 0, badName);

  console.log("\n[8] client disconnect releases the subscription");
  other.abort();
  check("stats drop to 1 channel / 2 subscribers", await waitFor(() => pubsubStats().channels === 1 && pubsubStats().subscribers === 2), JSON.stringify(pubsubStats()));

  console.log("\n[9] revoked token: open stream is closed");
  const t2 = await issueToken("verify-sse-4782-revoke");
  issued.push(t2);
  const r = track(await openStream(`${base}/mcp/subscribe/revoke-test`, { authorization: `Bearer ${t2.token}` }));
  check("second token subscribes", await waitFor(() => has(r, "ready")));
  await revokeToken(t2.id);
  check("stream got `revoked` and closed", await waitFor(() => has(r, "revoked") && r.closed, 5000), JSON.stringify(r.events));
  const again = await openStream(`${base}/mcp/subscribe/revoke-test`, { authorization: `Bearer ${t2.token}` });
  check("revoked token can no longer subscribe (401)", again.status === 401, `status ${again.status}`);

  console.log("\n[10] full transport stop/start (process-restart equivalent)");
  await closePubSub();
  check("stop ended every open stream", await waitFor(() => a.closed && b.closed, 3000), `a ${a.closed} b ${b.closed}`);
  server.closeAllConnections();
  await new Promise((res) => server.close(res));
  check("no listener backend remains after stop", (await listenerPid()).length === 0, JSON.stringify(await listenerPid()));
  resetPubSubForTests();
  ({ server, base } = await startHttp());
  // Deliberately subscribe with no startListener() call and no warm-up: the first subscriber must
  // cause the dedicated connection to come up on its own.
  const c = track(await openStream(`${base}/mcp/subscribe/test`, bearer));
  check("fresh subscriber after restart gets ready (listener came up on demand)", c.status === 200 && (await waitFor(() => has(c, "ready"))), `status ${c.status}`);
  await publish("test", { after: "restart" });
  check("and receives a publish", await waitFor(() => messages(c).includes('{"after":"restart"}')));
  check("new dedicated listener backend exists", typeof (await listenerPid()) === "number");
  c.abort();
  check("last disconnect leaves 0 channels", await waitFor(() => pubsubStats().channels === 0), JSON.stringify(pubsubStats()));

  await closePubSub();
  server.closeAllConnections();
  await new Promise((res) => server.close(res));
} catch (err) {
  failures += 1;
  console.log(`  FAIL unexpected error — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  for (const s of streams) s.abort();
  for (const t of issued) await revokeToken(t.id).catch(() => {});
  await raw.end().catch(() => {});
  await closePubSub().catch(() => {});
  await closePool().catch(() => {});
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
