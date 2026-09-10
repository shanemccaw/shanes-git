#!/usr/bin/env node
// Real end-to-end smoke test for the GitHub MCP server scaffold (Git #3390).
//
// Boots the server in-process on a test port, mints a real bearer token, and verifies:
//   1. a missing bearer token is rejected 401
//   2. an invalid/garbage bearer token is rejected 401
//   3. a valid token can initialize, list tools, and call server_status
//   4. github_whoami uses the server-side PAT (if configured) and returns an identity
//   5. the GitHub PAT NEVER appears in any response body, anywhere
//   6. a revoked token is rejected 401
//
// Exits non-zero on any failure. Cleans up its own token + activity rows afterward.

process.env.GITHUB_MCP_PORT = process.env.GITHUB_MCP_PORT || "8791";
process.env.GITHUB_MCP_HOST = "127.0.0.1";

import { loadEnvLocal, githubPat, serverHost, serverPort } from "../src/env.ts";
import { startServer } from "../src/server.ts";
import { issueToken } from "../src/tokens.ts";
import { query, closePool } from "../src/db.ts";

loadEnvLocal();

const BASE = `http://${serverHost()}:${serverPort()}`;
const PAT = githubPat();

let failures = 0;
const bodies = [];
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function rpc(token, message, { pathToken = false } = {}) {
  const url = pathToken ? `${BASE}/mcp/t/${token}` : `${BASE}/mcp`;
  const headers = { "content-type": "application/json" };
  if (token && !pathToken) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const text = await res.text();
  bodies.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, text, json };
}

const server = startServer();
await new Promise((r) => server.once("listening", r));

let tokenId = null;
try {
  console.log(`GitHub MCP smoke test against ${BASE}/mcp`);
  console.log(`PAT configured: ${PAT ? "yes" : "no"}`);

  // 1. missing token
  const noAuth = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  check("missing bearer token -> 401", noAuth.status === 401, `got ${noAuth.status}`);

  // 2. invalid token
  const badAuth = await rpc("ghmcp_not_a_real_token", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  check("invalid bearer token -> 401", badAuth.status === 401, `got ${badAuth.status}`);

  // Mint a real token
  const issued = await issueToken("smoke-test");
  tokenId = issued.id;
  const token = issued.token;
  check("minted token has ghmcp_ prefix", token.startsWith("ghmcp_"));

  // 3a. initialize
  const init = await rpc(token, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  check("initialize -> 200", init.status === 200, `got ${init.status}`);
  check("initialize returns serverInfo", init.json?.result?.serverInfo?.name === "shane-msp-github-mcp");

  // 3b. tools/list
  const list = await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const toolNames = (list.json?.result?.tools ?? []).map((t) => t.name);
  check("tools/list has server_status", toolNames.includes("server_status"), toolNames.join(","));
  check("tools/list has github_whoami", toolNames.includes("github_whoami"));
  check("tools/list has get_recent_activity", toolNames.includes("get_recent_activity"));

  // 3c. server_status
  const status = await rpc(token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "server_status", arguments: {} },
  });
  const statusStruct = status.json?.result?.structuredContent;
  check("server_status -> isError false", status.json?.result?.isError === false);
  check("server_status db up", statusStruct?.db === "up");
  check("server_status echoes token label", statusStruct?.authenticatedTokenLabel === "smoke-test");
  check("server_status patConfigured is boolean", typeof statusStruct?.patConfigured === "boolean");

  // 4. github_whoami (only asserts an identity when a PAT is actually configured)
  const whoami = await rpc(token, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "github_whoami", arguments: {} },
  });
  if (PAT) {
    const login = whoami.json?.result?.structuredContent?.login;
    check("github_whoami returns a login", typeof login === "string" && login.length > 0, whoami.text.slice(0, 200));
    console.log(`  ..   github_whoami login: ${login}`);
  } else {
    check("github_whoami reports PAT-not-configured cleanly", whoami.json?.result?.isError === true);
  }

  // get_recent_activity — should now show the calls we just made
  const activity = await rpc(token, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "get_recent_activity", arguments: { limit: 10 } },
  });
  const entries = activity.json?.result?.structuredContent?.entries ?? [];
  check("get_recent_activity returns entries", entries.length > 0, `got ${entries.length}`);
  check("activity recorded server_status call", entries.some((e) => e.tool === "server_status"));

  // 5. THE core security assertion: the PAT never appears in ANY response body
  if (PAT) {
    const leaked = bodies.some((b) => b.includes(PAT));
    check("PAT never appears in any response body", !leaked, "PAT LEAKED IN A RESPONSE");
  } else {
    check("PAT never appears in any response body (n/a — none configured)", true);
  }

  // 6. revoked token -> 401
  await query("UPDATE github_mcp_tokens SET revoked_at = now() WHERE id = $1", [tokenId]);
  const afterRevoke = await rpc(token, { jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  check("revoked token -> 401", afterRevoke.status === 401, `got ${afterRevoke.status}`);
} finally {
  // Clean up this test's own rows so the trail/token store isn't polluted.
  if (tokenId != null) {
    await query("DELETE FROM github_mcp_activity WHERE token_id = $1", [tokenId]).catch(() => {});
    await query("DELETE FROM github_mcp_tokens WHERE id = $1", [tokenId]).catch(() => {});
  }
  server.close();
  await closePool();
}

console.log("");
if (failures > 0) {
  console.log(`SMOKE TEST FAILED — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("SMOKE TEST PASSED");
process.exit(0);
