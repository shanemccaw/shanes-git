import type { ToolDef } from "./registry.ts";
import { listBlockedBy } from "../github.ts";
import { requireInt } from "./args.ts";

/** list_blocked_by(number) — real current blockers of `number` + their live state. */
export const listBlockedByTool: ToolDef = {
  name: "list_blocked_by",
  description:
    "Lists the real, current blocked_by dependencies of `number` — number/id/title/state/html_url " +
    "for each issue actually blocking it, from GitHub's own dependency graph (not prose).",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The issue to check." },
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = requireInt(args.number, "number");
    const blockedBy = await listBlockedBy(number);
    return { number, count: blockedBy.length, blockedBy };
  },
};
