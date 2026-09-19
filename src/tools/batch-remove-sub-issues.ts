import type { ToolDef } from "./registry.ts";
import { detachSubIssue } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

interface Removal {
  childNumber: number;
  parentNumber: number;
}

function parseRemovals(value: unknown): Removal[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("`removals` must be a non-empty array of { childNumber, parentNumber }");
  }
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`removals[${i}] must be an object with childNumber, parentNumber`);
    }
    const obj = raw as Record<string, unknown>;
    return {
      childNumber: requireInt(obj.childNumber, `removals[${i}].childNumber`),
      parentNumber: requireInt(obj.parentNumber, `removals[${i}].parentNumber`),
    };
  });
}

/**
 * `batch_remove_sub_issues(removals[])` — Git #4822. The real trigger: #1202
 * hit GitHub's 100-sub-issue cap mostly with closed/landed work, and freeing
 * those slots one `remove_sub_issue` call at a time is avoidable overhead.
 *
 * Each entry runs the same detach `remove_sub_issue` uses (GitHub's
 * `DELETE /issues/{parent}/sub_issue`), via `detachSubIssue()` — which never
 * closes, reopens or otherwise touches the child. Unlike `batch_reparent_sub_issues`
 * there is no re-add: the child simply ends up with no parent. Run and reported
 * ONE ENTRY AT A TIME, sequentially (GitHub's secondary rate limits make a burst
 * of concurrent writes against one repo a real risk), and never all-or-nothing.
 */
export const batchRemoveSubIssuesTool: ToolDef = {
  name: "batch_remove_sub_issues",
  description:
    "Bulk-detaches sub-issues from their parents WITHOUT re-parenting them. For each " +
    "{ childNumber, parentNumber } in `removals`, removes childNumber as a sub-issue of " +
    "parentNumber — the same real detach remove_sub_issue performs; the child issue itself is " +
    "never closed, reopened or otherwise touched, it just ends up with no parent (use " +
    "batch_reparent_sub_issues instead to move children under a new parent). Frees slots on a " +
    "parent at GitHub's 100-sub-issue cap. Every entry is attempted and reported INDEPENDENTLY, " +
    "one at a time — one real failure never blocks or rolls back the others. Returns " +
    "{ totalAttempted, succeededCount, failedCount, results[] }; each result has " +
    "childNumber/parentNumber/success and, on failure, a real `error` message. Required: context " +
    "(Git #3538 — a short label identifying which chat/session/build is making this write; " +
    "rejected before any GitHub call if missing). Optional `repo` (Git #3580) applies to every " +
    "removal in the batch.",
  inputSchema: {
    type: "object",
    properties: {
      removals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            childNumber: { type: "integer", description: "The sub-issue to detach." },
            parentNumber: { type: "integer", description: "The parent to detach it from." },
          },
          required: ["childNumber", "parentNumber"],
          additionalProperties: false,
        },
        minItems: 1,
        description: "The real detachments to perform, each independently attempted and reported.",
      },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["removals", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const removals = parseRemovals(args.removals);
    const repo = resolveRepo(args.repo);

    const results: Array<Record<string, unknown>> = [];
    for (const removal of removals) {
      try {
        await detachSubIssue(removal.parentNumber, removal.childNumber, repo);
        results.push({ childNumber: removal.childNumber, parentNumber: removal.parentNumber, success: true });
      } catch (err) {
        results.push({
          childNumber: removal.childNumber,
          parentNumber: removal.parentNumber,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const succeededCount = results.filter((r) => r.success === true).length;
    return {
      totalAttempted: results.length,
      succeededCount,
      failedCount: results.length - succeededCount,
      results,
    };
  },
};
