import type { ToolDef } from "./registry.ts";
import { removeSubIssue } from "../github.ts";
import { CONTEXT_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

/**
 * remove_sub_issue(parent_number, child_number) — for re-parenting. GitHub's real
 * API enforces one-parent-at-a-time, so moving a sub-issue means removing it from
 * its current parent here first, then add_sub_issue onto the new one.
 */
export const removeSubIssueTool: ToolDef = {
  name: "remove_sub_issue",
  description:
    "Removes child_number as a sub-issue of parent_number (does not close or otherwise touch the " +
    "child issue itself). Use before add_sub_issue when re-parenting, per GitHub's one-parent rule. " +
    "Returns the parent's remaining sub-issue list afterward. Required: context (Git #3538 — a " +
    "short label identifying which chat/session/build is making this write; rejected before any " +
    "GitHub call if missing).",
  inputSchema: {
    type: "object",
    properties: {
      parent_number: { type: "integer", description: "The current parent issue number." },
      child_number: { type: "integer", description: "The sub-issue number to detach." },
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["parent_number", "child_number", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const parentNumber = requireInt(args.parent_number, "parent_number");
    const childNumber = requireInt(args.child_number, "child_number");
    const subIssues = await removeSubIssue(parentNumber, childNumber);
    return { parentNumber, childNumber, subIssues };
  },
};
