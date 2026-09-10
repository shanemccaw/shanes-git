import type { ToolDef } from "./registry.ts";
import { isPatConfigured } from "../github.ts";
import { query } from "../db.ts";

/**
 * A no-argument health probe. Confirms the scaffold is wired end-to-end: the
 * server is reachable, the DB is up, and a PAT is configured — WITHOUT ever
 * revealing the PAT (only a boolean). Also echoes which bearer token label made
 * the call, so a freshly-connected Claude can confirm its own auth works.
 */
export const serverStatusTool: ToolDef = {
  name: "server_status",
  description:
    "Health check for the GitHub MCP server. Returns server identity, whether the DB is " +
    "reachable, and whether a GitHub PAT is configured server-side (a boolean only — the " +
    "token itself is never returned). Confirms your bearer token authenticated.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    let dbUp = false;
    try {
      await query("SELECT 1");
      dbUp = true;
    } catch {
      dbUp = false;
    }
    return {
      server: "shane-msp-github-mcp",
      version: "0.1.0",
      authenticatedTokenLabel: ctx.tokenLabel,
      db: dbUp ? "up" : "down",
      // Boolean only — the PAT value is held server-side and never surfaced.
      patConfigured: isPatConfigured(),
    };
  },
};
