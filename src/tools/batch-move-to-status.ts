import type { ToolDef } from "./registry.ts";
import { ALLOWED_STATUSES, moveIssueToStatus } from "./move-to-status.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, requireInt } from "./args.ts";

interface StatusMove {
  number: number;
  status: string;
}

function parseMoves(value: unknown): StatusMove[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("`moves` must be a non-empty array of { number, status }");
  }
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`moves[${i}] must be an object with number, status`);
    }
    const obj = raw as Record<string, unknown>;
    const number = requireInt(obj.number, `moves[${i}].number`);
    // `status` itself is validated inside moveIssueToStatus() per item, not
    // here — an invalid status must fail only that one item, not the parse
    // of the whole batch.
    const status = typeof obj.status === "string" ? obj.status : "";
    return { number, status };
  });
}

/**
 * `batch_move_to_status(moves[])` — Git #3709 (Feature #3377). Bulk board
 * moves, the second real ask in #3709's own body, same real motivation as
 * `batch_reparent_sub_issues`: a chat doing board cleanup across dozens of
 * issues previously had to call `move_to_status` once per issue with no way
 * to see a single combined result.
 *
 * Each move runs `moveIssueToStatus()` (the same real single-issue logic
 * `move_to_status` itself calls, in `./move-to-status.ts`) ONE AT A TIME,
 * sequentially — never in parallel, for the same real GitHub secondary
 * rate-limit reason `batch_reparent_sub_issues` avoids it. Never
 * all-or-nothing: an invalid `status` string or a real 404 on one item is
 * reported for that item alone.
 */
export const batchMoveToStatusTool: ToolDef = {
  name: "batch_move_to_status",
  description:
    "Bulk moves issues to a real Projects v2 board column. For each { number, status } in " +
    "`moves`, moves that issue to one of: " +
    ALLOWED_STATUSES.map((s) => `"${s}"`).join(", ") +
    " — same real vocabulary and validation as move_to_status, applied per item so an invalid " +
    "status on one move fails only that move. Every move is attempted and reported " +
    "INDEPENDENTLY, one at a time — one real failure never blocks or rolls back the others. " +
    "Returns { totalAttempted, succeededCount, failedCount, results[] }; each result has " +
    "number/status/success, and on success projectItemId/addedToBoard, or on failure a real " +
    "`error` message (e.g. the issue doesn't exist, or an unrecognized status string). " +
    "Required: context (Git #3538 — a short label identifying which chat/session/build is " +
    "making this write; rejected before any GitHub call if missing). Optional `repo` (Git " +
    "#3580) targets a different repo for every issue lookup in the batch — the board itself is " +
    "one shared board and does not vary by repo.",
  inputSchema: {
    type: "object",
    properties: {
      moves: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer", description: "The GitHub issue number to move." },
            status: {
              type: "string",
              enum: ALLOWED_STATUSES,
              description: "The real board column to move it to.",
            },
          },
          required: ["number", "status"],
          additionalProperties: false,
        },
        minItems: 1,
        description: "The real board moves to perform, each independently attempted and reported.",
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
        const outcome = await moveIssueToStatus(move.number, move.status, repo);
        results.push({
          number: move.number,
          status: outcome.status,
          projectItemId: outcome.projectItemId,
          addedToBoard: outcome.addedToBoard,
          success: true,
        });
      } catch (err) {
        results.push({
          number: move.number,
          status: move.status,
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
