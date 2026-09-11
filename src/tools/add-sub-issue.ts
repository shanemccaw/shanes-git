import type { ToolDef } from "./registry.ts";
import { addSubIssue } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

/**
 * add_sub_issue(parent_number, child_number) — Feature #3377's sub-issue hierarchy
 * tool (Git #3392). Resolves the child's real internal `id` internally; the
 * caller only ever passes plain issue numbers. Per GitHub's own one-parent-at-a-
 * time rule, a child already parented elsewhere must be removed from its old
 * parent first (remove_sub_issue) or this call fails — that's a real GitHub 4xx,
 * surfaced as-is rather than silently reparented.
 */
export const addSubIssueTool: ToolDef = {
  name: "add_sub_issue",
  description:
    "Adds child_number as a real GitHub sub-issue of parent_number. Resolves the child's internal " +
    "id internally — pass plain issue numbers. Returns the parent's full sub-issue list afterward. " +
    "Fails with GitHub's own error if the child already has a different parent (remove it there " +
    "first). Required: context (Git #3538 — a short label identifying which chat/session/build " +
    "is making this write; rejected before any GitHub call if missing). Optional `repo` (Git " +
    "#3580) targets a different repo (applied to both parent and child — a single call targets " +
    "one repo, not a cross-repo pairing); defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      parent_number: { type: "integer", description: "The issue number to become the parent." },
      child_number: { type: "integer", description: "The issue number to add as a sub-issue." },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["parent_number", "child_number", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const parentNumber = requireInt(args.parent_number, "parent_number");
    const childNumber = requireInt(args.child_number, "child_number");
    const repo = resolveRepo(args.repo);
    const subIssues = await addSubIssue(parentNumber, childNumber, repo);
    return { parentNumber, childNumber, subIssues };
  },
};
