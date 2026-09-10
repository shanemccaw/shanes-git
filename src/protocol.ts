// A real MCP server: JSON-RPC 2.0 over the Streamable HTTP transport.
//
// Written directly against the spec (the same approach as web/shanes-life's own MCP server)
// rather than pulled in from @modelcontextprotocol/sdk, because the server half of the protocol
// is genuinely small: initialize, tools/list, tools/call, ping, and the empty resources/prompts
// probes clients send on connect. Responses are plain application/json — the spec permits that
// for a request that produces exactly one response, and none of these tools stream.

import { TOOLS_BY_NAME, toolManifest } from "./tools/index.ts";
import { runTool, type ToolContext } from "./tools/registry.ts";

export const SERVER_INFO = { name: "shane-msp-github-mcp", title: "Shane MSP GitHub MCP", version: "0.1.0" };

// Versions this server actually implements. A client asking for something else still gets a
// working session — it is just told which version it is really talking to.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification (which gets an empty 202 at the transport layer).
 */
async function handleMessage(msg: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return fail(null, INVALID_REQUEST, "Request must be a JSON-RPC object");
  }
  const record = msg as { id?: string | number | null; method?: unknown; params?: unknown };
  const id = record.id ?? null;
  const isNotification = record.id === undefined || record.id === null;
  const method = record.method;
  const params = (record.params && typeof record.params === "object" ? record.params : {}) as Record<string, unknown>;

  if (typeof method !== "string") {
    return isNotification ? null : fail(id, INVALID_REQUEST, "Missing method");
  }

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version =
        typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "GitHub operations for Shane's MSP build queue. The GitHub PAT is held server-side and " +
          "is never passed through chat or returned by any tool. Call server_status to confirm the " +
          "connection, github_whoami to see which account the PAT authenticates as, and " +
          "get_recent_activity to read this server's audit trail.",
      });
    }

    // Notifications carry no id and get no JSON-RPC response at all.
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: toolManifest() });

    case "resources/list":
      return ok(id, { resources: [] });

    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });

    case "prompts/list":
      return ok(id, { prompts: [] });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return fail(id, INVALID_PARAMS, "tools/call requires a string `name`");
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await runTool(tool, args, ctx);
        const text = JSON.stringify(result, null, 2);
        return ok(id, {
          content: [{ type: "text", text }],
          structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { result },
          isError: false,
        });
      } catch (err) {
        // A tool that fails reports a real, readable failure to the model as a tool result —
        // not a protocol-level error, and never a fabricated success.
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`[mcp] tool ${name} failed: ${message}`);
        return ok(id, {
          content: [{ type: "text", text: `${name} failed: ${message}` }],
          isError: true,
        });
      }
    }

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

export interface RpcResult {
  status: number;
  body: JsonRpcResponse | JsonRpcResponse[] | null;
}

/** Handle a raw request body (single message or a batch). */
export async function handleRpc(rawBody: Buffer, ctx: ToolContext): Promise<RpcResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return { status: 400, body: fail(null, PARSE_ERROR, `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`) };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { status: 400, body: fail(null, INVALID_REQUEST, "Empty batch") };
    }
    const responses: JsonRpcResponse[] = [];
    for (const msg of parsed) {
      try {
        const res = await handleMessage(msg, ctx);
        if (res) responses.push(res);
      } catch (err) {
        const rid = (msg as { id?: string | number | null } | null)?.id ?? null;
        responses.push(fail(rid, INTERNAL_ERROR, err instanceof Error ? err.message : String(err)));
      }
    }
    // An all-notification batch produces no responses at all.
    return responses.length === 0 ? { status: 202, body: null } : { status: 200, body: responses };
  }

  try {
    const res = await handleMessage(parsed, ctx);
    return res === null ? { status: 202, body: null } : { status: 200, body: res };
  } catch (err) {
    const rid = (parsed as { id?: string | number | null } | null)?.id ?? null;
    ctx.log(`[mcp] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return { status: 200, body: fail(rid, INTERNAL_ERROR, err instanceof Error ? err.message : String(err)) };
  }
}
