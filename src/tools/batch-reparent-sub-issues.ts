import type { ToolDef } from "./registry.ts";
import { reparentSubIssue, ReparentPartialFailureError } from "../hierarchy.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

interface ReparentMove {
  issueNumber: number;
  fromParent: number;
  toParent: number;
}

function parseMoves(value: unknown): ReparentMove[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("`moves` must be a non-empty array of { issueNumber, fromParent, toParent }");
  }
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`moves[${i}] must be an object with issueNumber, fromParent, toParent`);
    }
    const obj = raw as Record<string, unknown>;
    return {
      issueNumber: requireInt(obj.issueNumber, `moves[${i}].issueNumber`),
      fromParent: requireInt(obj.fromParent, `moves[${i}].fromParent`),
      toParent: requireInt(obj.toParent, `moves[${i}].toParent`),
    };
  });
}

/**
 * `batch_reparent_sub_issues(moves[])` — Git #3709 (Feature #3377). The real,
 * direct motivation is named in the issue's own body: the #1202 sub-issue
 * reorganization needed 166+ individual real `removeSubIssue`/`addSubIssue`
 * mutation pairs for 83 issues, done via a raw script outside this server
 * entirely because no batch tool existed.
 *
 * Each move is `remove_sub_issue(fromParent)` then `add_sub_issue(toParent)`
 * — the same real hierarchy enforcement and proactive 100-sub-issue-cap
 * overflow redirect `add_sub_issue` itself applies (Git #3708), via
 * `reparentSubIssue()` in `../hierarchy.ts` — run and reported ONE MOVE AT A
 * TIME, sequentially (never in parallel — GitHub's own secondary rate limits
 * make a burst of concurrent writes against the same repo a real risk, not a
 * theoretical one). Never all-or-nothing: item 40 of 80 failing (e.g. the
 * real target is genuinely at its cap with no overflow Epic to redirect
 * through) does not touch the other 79 real results.
 *
 * A move that removes the child from `fromParent` but then fails to attach it
 * under `toParent` is a real, distinct partial failure — the child now
 * genuinely has no parent — and is reported with `partial: true` rather than
 * folded into an ordinary failure that reads as "nothing happened."
 */
export const batchReparentSubIssuesTool: ToolDef = {
  name: "batch_reparent_sub_issues",
  description:
    "Bulk re-parents sub-issues. For each { issueNumber, fromParent, toParent } in `moves`, " +
    "removes issueNumber as a sub-issue of fromParent then adds it under toParent — applying " +
    "the same real Epic/Feature hierarchy enforcement and proactive 100-sub-issue-cap overflow " +
    "redirect add_sub_issue itself applies (Git #3708). Every move is attempted and reported " +
    "INDEPENDENTLY, one at a time — one real failure never blocks or rolls back the others. " +
    "Returns { totalAttempted, succeededCount, failedCount, results[] }; each result has " +
    "issueNumber/fromParent/toParent/success, and on success the real parent actually landed " +
    "under (toParent, which may differ from the requested one if redirected to an overflow " +
    "Feature — see requestedToParent/redirected/redirectReason), or on failure a real `error` " +
    "message with `partial: true` set for the distinct case where the child was already removed " +
    "from fromParent before the add under toParent failed, leaving it with no parent — that case " +
    "needs manual attention, not a retry of the same move. Required: context (Git #3538 — a " +
    "short label identifying which chat/session/build is making this write; rejected before any " +
    "GitHub call if missing). Optional `repo` (Git #3580) applies to every move in the batch.",
  inputSchema: {
    type: "object",
    properties: {
      moves: {
        type: "array",
        items: {
          type: "object",
          properties: {
            issueNumber: { type: "integer", description: "The sub-issue to move." },
            fromParent: { type: "integer", description: "Its current real parent." },
            toParent: { type: "integer", description: "The real parent to move it under." },
          },
          required: ["issueNumber", "fromParent", "toParent"],
          additionalProperties: false,
        },
        minItems: 1,
        description: "The real re-parent moves to perform, each independently attempted and reported.",
      },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["moves", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const moves = parseMoves(args.moves);
    const repo = resolveRepo(args.repo);

    const results: Array<Record<string, unknown>> = [];
    for (const move of moves) {
      try {
        const outcome = await reparentSubIssue(move.issueNumber, move.fromParent, move.toParent, repo);
        results.push({
          issueNumber: move.issueNumber,
          fromParent: move.fromParent,
          toParent: outcome.toParent,
          requestedToParent: outcome.requestedToParent,
          redirected: outcome.redirected,
          redirectReason: outcome.redirectReason,
          success: true,
        });
      } catch (err) {
        const partial = err instanceof ReparentPartialFailureError;
        results.push({
          issueNumber: move.issueNumber,
          fromParent: move.fromParent,
          toParent: move.toParent,
          success: false,
          partial,
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
