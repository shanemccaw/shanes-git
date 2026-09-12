import type { ToolDef } from "./registry.ts";
import { closeIssue, postIssueComment } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, tagCommentWithContext } from "./args.ts";

export interface CloseOneIssueResult {
  number: number;
  htmlUrl: string;
  state: string;
  stateReason: string | null;
  comment: { id: number; htmlUrl: string } | null;
}

/**
 * The real core of `close_issue` — enforces the repo's own standing rule
 * (CLAUDE.md: "A NOT_PLANNED closure always carries a real explanatory
 * comment", Git #2167): a `not_planned` close is REJECTED here — before any
 * GitHub call is made — unless a real, non-empty `comment` is supplied, and
 * that comment is posted FIRST, then the issue is closed. A `completed`
 * close never requires a comment (an optional one is still allowed) since
 * #2167 is specifically about the silent NOT_PLANNED case.
 *
 * Exported (Git #3709) so `batch_close_issues` runs this same real,
 * single-issue close per item — one bad state_reason/missing comment in a
 * batch fails only that item, never the others.
 */
export async function closeOneIssue(
  number: number,
  stateReason: "completed" | "not_planned",
  comment: string | undefined,
  context: string,
  repo?: { owner: string; repo: string },
): Promise<CloseOneIssueResult> {
  const rawComment = typeof comment === "string" ? comment.trim() : "";

  if (stateReason === "not_planned" && rawComment.length === 0) {
    // Rejected BEFORE any GitHub call — no partial state change is possible.
    throw new Error(
      "state_reason=not_planned requires a non-empty `comment` explaining the real decision " +
        "(what changed, what it's superseded by if applicable) — a silent NOT_PLANNED closure " +
        "is never acceptable (Git #2167). Supply `comment` and retry.",
    );
  }

  let postedComment: { id: number; htmlUrl: string } | null = null;
  if (rawComment.length > 0) {
    // Comment posts FIRST — if this throws, the issue is never closed, so a
    // failed comment can never silently leave a commentless NOT_PLANNED close.
    postedComment = await postIssueComment(number, tagCommentWithContext(context, rawComment), repo);
  }

  const closed = await closeIssue(number, stateReason, repo);

  return {
    number: closed.number,
    htmlUrl: closed.htmlUrl,
    state: closed.state,
    stateReason: closed.stateReason,
    comment: postedComment,
  };
}

export const closeIssueTool: ToolDef = {
  name: "close_issue",
  description:
    "Closes a GitHub issue with a real state_reason (`completed` or `not_planned`). " +
    "`not_planned` REQUIRES a non-empty `comment` explaining the real decision — the call is " +
    "rejected before any GitHub request is made if one isn't supplied — and that comment is " +
    "posted on the issue BEFORE it closes. Never closes an issue itself; this repo's issues are " +
    "closed only by Shane's own decision or an explicit instruction to close on his behalf. " +
    "Required: context (Git #3538 — a short label identifying which chat/session/build is " +
    "making this write; rejected before any GitHub call if missing). Optional `repo` (Git " +
    "#3580) targets a different repo; defaults to the server's configured repo. When a " +
    "`comment` is posted, it's prefixed with a visible `[chat: <context>]` tag.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1, description: "The issue number to close." },
      state_reason: {
        type: "string",
        enum: ["completed", "not_planned"],
        description: "Why the issue is closing.",
      },
      comment: {
        type: "string",
        description:
          "Required and must be non-empty when state_reason is not_planned — the real " +
          "explanation of what changed / what supersedes it. Optional for completed.",
      },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "state_reason", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const context = requireContext(args);
    const repo = resolveRepo(args.repo);
    const number = args.number;
    const stateReason = args.state_reason;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new Error("`number` must be a positive integer issue number.");
    }
    if (stateReason !== "completed" && stateReason !== "not_planned") {
      throw new Error('`state_reason` must be "completed" or "not_planned".');
    }
    const comment = typeof args.comment === "string" ? args.comment : undefined;
    return closeOneIssue(number, stateReason, comment, context, repo);
  },
};
