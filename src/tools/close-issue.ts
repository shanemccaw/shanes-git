import type { ToolDef } from "./registry.ts";
import { closeIssue, getIssueLabels, postIssueComment, removeIssueLabel } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext, tagCommentWithContext } from "./args.ts";

/**
 * The real terminal-state labels this architecture (Feature #4692 / #4697)
 * defines as meaningless once an issue is closed — stripped unconditionally on
 * every close so a verifying chat's whole job is "confirm this is real, say
 * close", not a separate manual label cleanup (Shane's stated intent, #4697).
 *
 * - `blocked` — the primary case (#4697's own verification target). The
 *   authoritative blocking mechanism is the `blocked_by` edge; the label is a
 *   cheap cross-repo index (#4692) and is simply meaningless on a closed issue.
 * - `in-flight` / `complete` — being retired entirely by the sibling
 *   BuildConsole issues (#4693/#4694); stripping any a legacy issue still
 *   carries keeps a closed issue from displaying a retired "being worked on /
 *   awaiting close" state.
 *
 * This is an ALLOWLIST — deliberately NOT `Shane To-Do` (still genuinely
 * useful, and an action Shane clears himself), and NOT `bug`/`security` (real
 * cross-repo classification, not workflow state). Nothing outside this list is
 * ever touched.
 */
export const TERMINAL_STATE_LABELS = ["blocked", "in-flight", "complete"] as const;

export interface CloseOneIssueResult {
  number: number;
  htmlUrl: string;
  state: string;
  stateReason: string | null;
  comment: { id: number; htmlUrl: string } | null;
  /** Terminal-state labels actually present-and-removed on this close (never anything else). */
  strippedLabels: string[];
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

  // Deterministic terminal-state-label cleanup (Feature #4692 / #4697). Runs
  // AFTER the close so a failed strip can never leave the issue open. Reads the
  // issue's real current labels and removes only those in TERMINAL_STATE_LABELS
  // that are actually present — never `Shane To-Do`, `bug`, `security`, or any
  // other label.
  const strippedLabels: string[] = [];
  const currentLabels = await getIssueLabels(number, repo);
  for (const label of TERMINAL_STATE_LABELS) {
    if (currentLabels.includes(label)) {
      await removeIssueLabel(number, label, repo);
      strippedLabels.push(label);
    }
  }

  return {
    number: closed.number,
    htmlUrl: closed.htmlUrl,
    state: closed.state,
    stateReason: closed.stateReason,
    comment: postedComment,
    strippedLabels,
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
    "`comment` is posted, it's prefixed with a visible `[chat: <context>]` tag. On close it " +
    "unconditionally strips any terminal-state labels the issue carries (" +
    TERMINAL_STATE_LABELS.map((l) => `\`${l}\``).join(", ") +
    ") — those are meaningless once closed — and never touches `Shane To-Do`, `bug`, `security`, " +
    "or any other label. The removed labels are returned in `strippedLabels`.",
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
