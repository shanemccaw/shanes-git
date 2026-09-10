import { recordActivity } from "../activity.ts";
import { logger } from "../logger.ts";

/**
 * The one shape every tool in this server is written as — a plain object with a
 * name, description, a JSON-Schema `inputSchema` (surfaced verbatim in
 * tools/list), an optional list of arg names to redact from the audit trail,
 * and an async handler returning raw JSON-serializable data. The handler never
 * builds an MCP envelope — protocol.ts stringifies its return into MCP content —
 * and never sees or handles the GitHub PAT (github.ts owns that).
 *
 * Error contract: throw. protocol.ts catches it and returns a real MCP isError
 * result carrying the message; the registry records the failure in the activity
 * trail. Handlers never fake a success.
 */
export interface ToolContext {
  /** The bearer token this call authenticated with — for the audit trail. */
  tokenId: number | null;
  tokenLabel: string | null;
  log: (msg: string) => void;
}

export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Arg names masked in the Recent-Activity trail (a secret's value never persists). */
  redactParams?: string[];
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Runs one tool handler with mandatory Recent-Activity recording around it.
 * Success and failure both land a row (best-effort — see activity.ts); the
 * result or the error is then handed back to protocol.ts unchanged.
 */
export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const result = await tool.handler(args, ctx);
    const durationMs = Date.now() - startedAt;
    logger.info({ tool: tool.name, ms: durationMs, tokenId: ctx.tokenId }, "tool call ok");
    await recordActivity({
      tokenId: ctx.tokenId,
      tokenLabel: ctx.tokenLabel,
      tool: tool.name,
      params: args,
      outcome: "success",
      durationMs,
      redactParams: tool.redactParams,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ tool: tool.name, ms: durationMs, err: message }, "tool call failed");
    await recordActivity({
      tokenId: ctx.tokenId,
      tokenLabel: ctx.tokenLabel,
      tool: tool.name,
      params: args,
      outcome: "failure",
      detail: message,
      durationMs,
      redactParams: tool.redactParams,
    });
    throw err;
  }
}
