import type { ToolDef } from "./registry.ts";
import { addSubIssue, getIssueSummary } from "../github.ts";
import { enforceHierarchyOrThrow, resolveOverflowParent } from "../hierarchy.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

/**
 * add_sub_issue(parent_number, child_number) — Feature #3377's sub-issue hierarchy
 * tool (Git #3392). Resolves the child's real internal `id` internally; the
 * caller only ever passes plain issue numbers. Per GitHub's own one-parent-at-a-
 * time rule, a child already parented elsewhere must be removed from its old
 * parent first (remove_sub_issue) or this call fails — that's a real GitHub 4xx,
 * surfaced as-is rather than silently reparented.
 *
 * Git #3708 adds two real checks before the write:
 *  1. Hierarchy enforcement — a non-Feature child (a plain bug/suggestion) is
 *     rejected outright if `parent_number` is an Epic (`enforceHierarchyOrThrow`).
 *  2. Proactive overflow — if `parent_number` is itself a Feature at/near
 *     GitHub's real 100-sub-issue cap, the child is silently redirected onto an
 *     existing "Part N" overflow sibling (creating the next one if none has
 *     room) rather than waiting for a hard 422 (`resolveOverflowParent`). The
 *     real parent it actually landed under is always reported back.
 */
export const addSubIssueTool: ToolDef = {
  name: "add_sub_issue",
  description:
    "Adds child_number as a real GitHub sub-issue of parent_number. Resolves the child's internal " +
    "id internally — pass plain issue numbers. Returns the parent's full sub-issue list afterward. " +
    "Fails with GitHub's own error if the child already has a different parent (remove it there " +
    "first). Enforces the repo's Epic → Feature → Issue hierarchy (Git #3708): rejects a " +
    "non-Feature child being added directly under an Epic, with a clear error. If parent_number is " +
    "itself a Feature at or near GitHub's real 100-sub-issue cap, automatically redirects the child " +
    "onto an existing \"<Feature> — Part N\" overflow sibling (or creates the next one) instead " +
    "of failing with a raw 422 — the response's `parentNumber`/`redirected`/`redirectReason` " +
    "name which real parent the child actually landed under. Required: context (Git #3538 — a " +
    "short label identifying which chat/session/build is making this write; rejected before any " +
    "GitHub call if missing). Optional `repo` (Git #3580) targets a different repo (applied to " +
    "both parent and child — a single call targets one repo, not a cross-repo pairing); " +
    "defaults to the server's configured repo.",
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

    const [parent, child] = await Promise.all([
      getIssueSummary(parentNumber, repo),
      getIssueSummary(childNumber, repo),
    ]);
    enforceHierarchyOrThrow(parent, child);

    const resolved = await resolveOverflowParent(parent, repo);
    const subIssues = await addSubIssue(resolved.targetParentNumber, childNumber, repo);
    return {
      parentNumber: resolved.targetParentNumber,
      requestedParentNumber: parentNumber,
      redirected: resolved.redirected,
      redirectReason: resolved.reason,
      childNumber,
      subIssues,
    };
  },
};
