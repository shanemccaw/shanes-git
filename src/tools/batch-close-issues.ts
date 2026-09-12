import type { ToolDef } from "./registry.ts";
import { closeOneIssue } from "./close-issue.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

interface Closure {
  number: number;
  stateReason: "completed" | "not_planned";
  comment?: string;
}

function parseClosures(value: unknown): Closure[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("`closures` must be a non-empty array of { number, stateReason, comment? }");
  }
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`closures[${i}] must be an object with number, stateReason, comment?`);
    }
    const obj = raw as Record<string, unknown>;
    const number = requireInt(obj.number, `closures[${i}].number`);
    // stateReason itself is validated per item below (not here) — an invalid
    // value must fail only that one item, not the parse of the whole batch.
    const stateReason = obj.stateReason === "completed" || obj.stateReason === "not_planned" ? obj.stateReason : null;
    const comment = typeof obj.comment === "string" ? obj.comment : undefined;
    return { number, stateReason: stateReason as "completed" | "not_planned", comment };
  });
}

/**
 * `batch_close_issues(closures[])` — Git #3709 (Feature #3377). Bulk closing,
 * the third real ask in #3709's own body. Each closure runs `closeOneIssue()`
 * (the same real single-issue logic `close_issue` itself calls, in
 * `./close-issue.ts` — including the repo's own standing Git #2167 rule that
 * a `not_planned` close is rejected unless a real, non-empty `comment` is
 * supplied, posted BEFORE the close) ONE AT A TIME, sequentially — never in
 * parallel, same real GitHub secondary rate-limit reason the other two batch
 * tools avoid it. Never all-or-nothing: a missing NOT_PLANNED comment or a
 * real 404 on one item is reported for that item alone; this NEVER closes an
 * issue itself without a genuine, correctly-formed request to do so — the
 * "you never close an issue" convention still means Shane's own decision (or
 * an explicit instruction on his behalf) drives every closure in the batch,
 * this tool just executes many of them at once instead of one call each.
 */
export const batchCloseIssuesTool: ToolDef = {
  name: "batch_close_issues",
  description:
    "Bulk closes issues. For each { number, stateReason, comment? } in `closures`, closes that " +
    "issue with a real state_reason (`completed` or `not_planned`) — same real validation as " +
    "close_issue, applied per item: `not_planned` REQUIRES a non-empty `comment`, rejected " +
    "before any GitHub call for that item if missing, and that comment is posted on the issue " +
    "BEFORE it closes (Git #2167). Every closure is attempted and reported INDEPENDENTLY, one " +
    "at a time — one real failure never blocks or rolls back the others. Returns " +
    "{ totalAttempted, succeededCount, failedCount, results[] }; each result has " +
    "number/success, and on success htmlUrl/state/stateReason/comment, or on failure a real " +
    "`error` message. Required: context (Git #3538 — a short label identifying which " +
    "chat/session/build is making this write; rejected before any GitHub call if missing). " +
    "Optional `repo` (Git #3580) applies to every closure in the batch. When a `comment` is " +
    "posted, it's prefixed with a visible `[chat: <context>]` tag, same as close_issue.",
  inputSchema: {
    type: "object",
    properties: {
      closures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer", description: "The issue number to close." },
            stateReason: {
              type: "string",
              enum: ["completed", "not_planned"],
              description: "Why the issue is closing.",
            },
            comment: {
              type: "string",
              description:
                "Required and must be non-empty when stateReason is not_planned — the real " +
                "explanation of what changed / what supersedes it. Optional for completed.",
            },
          },
          required: ["number", "stateReason"],
          additionalProperties: false,
        },
        minItems: 1,
        description: "The real closures to perform, each independently attempted and reported.",
      },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["closures", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const context = requireContext(args);
    const closures = parseClosures(args.closures);
    const repo = resolveRepo(args.repo);

    const results: Array<Record<string, unknown>> = [];
    for (const closure of closures) {
      try {
        if (!closure.stateReason) {
          throw new Error('`stateReason` must be "completed" or "not_planned".');
        }
        const outcome = await closeOneIssue(closure.number, closure.stateReason, closure.comment, context, repo);
        results.push({
          number: outcome.number,
          htmlUrl: outcome.htmlUrl,
          state: outcome.state,
          stateReason: outcome.stateReason,
          comment: outcome.comment,
          success: true,
        });
      } catch (err) {
        results.push({
          number: closure.number,
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
