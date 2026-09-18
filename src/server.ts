// HTTP entry point for the GitHub MCP server.
//
// Two ways in, both authenticating against the same github_mcp_tokens table (same shape as
// web/shanes-life's MCP route):
//
//   POST /mcp            with `Authorization: Bearer ghmcp_...`  — the correct form.
//   POST /mcp/t/<token>  the token in the path — a capability URL for clients with no header
//                        field. Same class of secret; still revocable, still audited.
//
// Server-push (Git #4782) accepts the same two forms:
//
//   GET /mcp/subscribe/<channel>            with `Authorization: Bearer ghmcp_...`
//   GET /mcp/t/<token>/subscribe/<channel>  the token in the path
//
// — a Server-Sent Events stream of whatever gets published to <channel>. See subscribe.ts.
//
// The GitHub PAT is NOT this bearer token. The bearer authenticates the Claude connection TO this
// server; the PAT (held in the server's env) is what the server uses to talk to GitHub. Neither is
// ever echoed to the caller.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { handleRpc, SERVER_INFO } from "./protocol.ts";
import { resolveToken } from "./tokens.ts";
import { readBody, sendJson } from "./http.ts";
import { isPatConfigured } from "./github.ts";
import { serverHost, serverPort } from "./env.ts";
import { handleSubscribe } from "./subscribe.ts";
import { logger } from "./logger.ts";

const MAX_RPC_BYTES = 2_000_000;
const SUBSCRIBE_HEADER_PREFIX = "/mcp/subscribe/";
const SUBSCRIBE_PATH_TOKEN_RE = /^\/mcp\/t\/([^/]+)\/subscribe\/(.*)$/;

function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, "").trim();
  }
  const alt = req.headers["x-mcp-token"];
  return typeof alt === "string" && alt ? alt.trim() : null;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathToken: string | null,
): Promise<void> {
  const token = pathToken || bearerFrom(req);
  if (!token) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="shane-msp-github-mcp"');
    return sendJson(res, 401, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message:
          "Missing MCP token. Send `Authorization: Bearer ghmcp_...`, or use the /mcp/t/<token> " +
          "URL form. Mint one with `npm run mint-token -- --label \"...\"`.",
      },
    });
  }

  const auth = await resolveToken(token);
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="shane-msp-github-mcp", error="invalid_token"');
    return sendJson(res, 401, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "That MCP token is not valid, or it has been revoked." },
    });
  }

  const body = await readBody(req, MAX_RPC_BYTES);
  const { status, body: payload } = await handleRpc(body, {
    tokenId: auth.tokenId,
    tokenLabel: auth.label,
    log: (m: string) => logger.info(m),
  });

  // The Streamable HTTP transport wants a session id echoed on later requests. This server is
  // genuinely stateless between calls — every request re-authenticates from the token — so the
  // token id is a stable, honest value to hand back rather than inventing session bookkeeping.
  res.setHeader("Mcp-Session-Id", String(auth.tokenId));

  if (payload === null) {
    res.writeHead(status);
    return void res.end();
  }
  return sendJson(res, status, payload);
}

function describeMcpEndpoint(res: ServerResponse): void {
  sendJson(res, 200, {
    server: SERVER_INFO.name,
    transport: "streamable-http",
    auth: "Authorization: Bearer ghmcp_... (or POST to /mcp/t/<token>)",
    patConfigured: isPatConfigured(),
    subscribe:
      "GET /mcp/subscribe/<channel> (Bearer header) or GET /mcp/t/<token>/subscribe/<channel> " +
      "opens a Server-Sent Events stream of what is published to that channel.",
    note: "POST JSON-RPC 2.0 here. GET on /mcp itself is informational only; the SSE stream is at /mcp/subscribe/<channel>.",
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // ---- SSE subscribe: same two token forms as /mcp -----------------------------------------
  if (pathname.startsWith(SUBSCRIBE_HEADER_PREFIX)) {
    return handleSubscribe(req, res, bearerFrom(req), pathname.slice(SUBSCRIBE_HEADER_PREFIX.length));
  }
  const pathTokenSubscribe = SUBSCRIBE_PATH_TOKEN_RE.exec(pathname);
  if (pathTokenSubscribe) {
    let pathToken: string;
    try {
      pathToken = decodeURIComponent(pathTokenSubscribe[1]);
    } catch {
      return void sendJson(res, 400, { error: "Token is not valid percent-encoding." });
    }
    return handleSubscribe(req, res, pathToken, pathTokenSubscribe[2]);
  }

  // ---- MCP: authenticated by its own bearer token ----------------------------------------
  if (pathname === "/mcp" || pathname.startsWith("/mcp/t/")) {
    if (method === "GET") return void describeMcpEndpoint(res);
    if (method === "DELETE") {
      // Streamable HTTP session teardown. Nothing to tear down; answer honestly.
      res.writeHead(204);
      return void res.end();
    }
    if (method !== "POST") {
      res.writeHead(405, { allow: "GET, POST, DELETE" });
      return void res.end();
    }
    const pathToken = pathname.startsWith("/mcp/t/")
      ? decodeURIComponent(pathname.slice("/mcp/t/".length))
      : null;
    return handleMcpRequest(req, res, pathToken);
  }

  // ---- health ---------------------------------------------------------------------------
  if (pathname === "/healthz") {
    return void sendJson(res, 200, { ok: true, service: SERVER_INFO.name });
  }

  // ---- OAuth discovery probes (RFC 8414 / RFC 9728). mcp-remote — the bridge Claude Desktop
  // uses — probes several `/.well-known/...` variants before sending the bearer token, even
  // though this server does bearer-token auth only and implements none of them. A real 404 on
  // any path containing a `.well-known` segment is enough: mcp-remote treats a 404 on these as
  // "not implemented" and proceeds straight to the bearer token it already has. Same fix
  // web/shanes-life's server applies. ------------------------------------------------------
  if (pathname === "/.well-known" || pathname.includes("/.well-known/")) {
    return void sendJson(res, 404, { error: "Not found" });
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: `Not found: ${method} ${pathname}` }));
}

export function createMcpHttpServer(): Server {
  const server = createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info(
        { method: req.method, path: (req.url ?? "").split("?")[0], status: res.statusCode, ms: Date.now() - started },
        "request",
      );
    });
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        logger.error({ err: message }, "error after headers");
        return void res.end();
      }
      sendJson(res, 500, { error: message });
    });
  });
  return server;
}

export function startServer(): Server {
  const server = createMcpHttpServer();
  const host = serverHost();
  const port = serverPort();
  server.listen(port, host, () => {
    logger.info({ host, port, endpoint: `http://${host}:${port}/mcp`, patConfigured: isPatConfigured() }, "MCP server ready (streamable-http)");
  });
  return server;
}
