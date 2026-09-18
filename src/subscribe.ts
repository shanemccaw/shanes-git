// GET /mcp/subscribe/<channel>  (Authorization: Bearer ...)
// GET /mcp/t/<token>/subscribe/<channel>  (token in the path, for clients that cannot set headers)
//
// A Server-Sent Events stream of whatever gets published to <channel> (Git #4782). This is the
// mechanism that lets a client behind NAT — no public address, so nothing can push to it — receive
// changes without polling: it holds this connection open and the server writes to it.
//
// Wire format:
//   event: ready     data: {"channel":"<name>"}   sent once LISTEN is live; anything published
//                                                  after this arrives on the stream
//   event: message   data: <the NOTIFY payload, verbatim>
//   event: resync    data: {"reason":"listener-reconnected"}   the server's database listener
//                    dropped and came back; notifications in the gap are gone, so re-fetch state
//   event: revoked   data: {}                     the bearer token was revoked; stream then closes
//   : keepalive      comment line every heartbeat interval, so idle-timeout proxies do not cut it
//
// This route has no idea what any channel means. Auth is the same github_mcp_tokens check as /mcp.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isTokenLive, resolveToken } from "./tokens.ts";
import { sendJson } from "./http.ts";
import { sseHeartbeatMs, sseTokenRecheckMs } from "./env.ts";
import { PubSubUnavailableError, subscribe, validateChannel, type Subscriber } from "./pubsub.ts";
import { logger } from "./logger.ts";

const log = logger.child({ subsystem: "sse" });

/** A client that stops reading gets dropped rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 1_000_000;

function frame(event: string, data: string): string {
  // A newline inside `data` would end the field; SSE carries multi-line data as repeated data: lines.
  const lines = data.split(/\r\n|\r|\n/).map((l) => `data: ${l}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}

export async function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | null,
  rawChannel: string,
): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    return void res.end();
  }

  if (!token) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="shane-msp-github-mcp"');
    return sendJson(res, 401, {
      error:
        "Missing MCP token. Send `Authorization: Bearer ghmcp_...`, or use the " +
        "/mcp/t/<token>/subscribe/<channel> URL form.",
    });
  }
  const auth = await resolveToken(token);
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="shane-msp-github-mcp", error="invalid_token"');
    return sendJson(res, 401, { error: "That MCP token is not valid, or it has been revoked." });
  }

  let channel: string;
  try {
    channel = decodeURIComponent(rawChannel);
  } catch {
    return sendJson(res, 400, { error: "Channel name is not valid percent-encoding." });
  }
  const problem = validateChannel(channel);
  if (problem) return sendJson(res, 400, { error: problem });

  // Events can arrive the instant LISTEN is acknowledged, before we have written the response
  // head. Queue them until the stream is open so none are dropped or written out of order.
  let queue: Array<[string, string]> | null = [];
  let ended = false;
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;
  const opened = Date.now();

  const write = (chunk: string): void => {
    if (ended) return;
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      log.warn({ tokenId: auth.tokenId, channel }, "SSE client not reading; dropping stream");
      res.destroy();
      return;
    }
    res.write(chunk);
  };

  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const t of timers) clearInterval(t);
    unsubscribe?.();
    if (!res.writableEnded) res.end();
    log.info({ tokenId: auth.tokenId, channel, seconds: Math.round((Date.now() - opened) / 1000) }, "SSE stream closed");
  };

  const sub: Subscriber = {
    deliver(event, data) {
      if (queue) queue.push([event, data]);
      else write(frame(event, data));
    },
    end: finish,
  };

  // Registered before the await so a client that disconnects mid-setup still cleans up.
  res.on("close", finish);

  try {
    unsubscribe = await subscribe(channel, sub);
  } catch (err) {
    if (err instanceof PubSubUnavailableError) {
      log.error({ err: err.message, channel }, "SSE subscribe failed; push transport unavailable");
      res.setHeader("Retry-After", "5");
      ended = true;
      return sendJson(res, 503, { error: err.message });
    }
    throw err;
  }
  if (ended) {
    // The client went away while we were subscribing; finish() ran before unsubscribe existed.
    unsubscribe();
    return;
  }

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 15_000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell nginx-style proxies not to buffer the stream
  });
  res.flushHeaders();
  write("retry: 3000\n\n");
  write(frame("ready", JSON.stringify({ channel })));
  const pending = queue;
  queue = null;
  for (const [event, data] of pending) write(frame(event, data));
  log.info({ tokenId: auth.tokenId, channel }, "SSE stream opened");

  timers.push(setInterval(() => write(": keepalive\n\n"), sseHeartbeatMs()));
  timers.push(
    setInterval(() => {
      isTokenLive(auth.tokenId)
        .then((live) => {
          if (live || ended) return;
          write(frame("revoked", "{}"));
          finish();
        })
        .catch((err: unknown) => {
          // A database blip must not disconnect every subscriber; try again next interval.
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "SSE token re-check failed");
        });
    }, sseTokenRecheckMs()),
  );
}
