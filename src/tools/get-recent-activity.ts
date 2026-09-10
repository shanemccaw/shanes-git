import type { ToolDef } from "./registry.ts";
import { listActivity } from "../activity.ts";

/**
 * The Recent-Activity trail readout (Feature #3377's Audit tool). Every real
 * call this server has made, newest first, with the calling token's label, the
 * redacted params, and the outcome — the same spirit as Shane's Life's
 * Settings → Recent Activity. The PAT never appears in these rows.
 */
export const getRecentActivityTool: ToolDef = {
  name: "get_recent_activity",
  description:
    "Lists this server's recent tool calls (newest first) — token label, tool, redacted params, " +
    "outcome, timestamp. The audit trail of what each connected Claude has done. Optional `limit` " +
    "(default 20, max 200).",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 200, description: "How many entries to return (default 20)." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const entries = await listActivity(limit);
    return { count: entries.length, entries };
  },
};
