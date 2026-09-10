import type { ToolDef } from "./registry.ts";
import { postIssueComment } from "../github.ts";
import { CONTEXT_SCHEMA_PROPERTY, requireContext, tagCommentWithContext } from "./args.ts";

/**
 * Posts a real comment on a real issue — this is the mechanism the standing
 * "mandatory: comment on the issue before finishing" / BUILD: header / bookend
 * conventions all rely on. The comment body is passed through verbatim (aside
 * from the `[chat: <context>]` prefix below); the caller (the model) is
 * responsible for the standing conventions (Posted: timestamp, findings list,
 * etc.) — this tool has no other opinion on shape. Shares `postIssueComment()`
 * in github.ts with `close_issue`'s NOT_PLANNED-comment enforcement (Git #3394).
 *
 * Git #3538: `context` is required, and — since every write authenticates as
 * the same server-side PAT and shows on GitHub as "shanemccaw" regardless of
 * which chat made it — this is the one write tool where the trail can be made
 * visible directly on GitHub itself, not just in the local audit log: the
 * posted body is prefixed with a real `[chat: <context>]` tag. Decision
 * (issue's own open question, item 4): apply this to every real comment body
 * this server writes, not `post_comment` alone — `close_issue`'s NOT_PLANNED
 * comment goes through the same `postIssueComment()` call site conceptually
 * and gets the same tag (see close-issue.ts). `create_issue`/`update_issue`,
 * the sub-issue/blocked_by tools, and `move_to_status` do NOT get a tag —
 * they have no free-text comment body to embed one into (the issue's own
 * body isn't a comment, and a board move has no text field at all), so their
 * `context` is traceable only through the audit log, per the issue body's own
 * observation that those writes "don't have a natural place to embed free
 * text the same way."
 */
export const postCommentTool: ToolDef = {
  name: "post_comment",
  description:
    "Posts a comment on a GitHub issue (or PR — same numbering) in the repo this server is " +
    "configured for. Returns the created comment's id, htmlUrl, and createdAt. Required: number, " +
    "body, context (Git #3538 — a short label identifying which chat/session/build is making " +
    "this write; rejected before any GitHub call if missing). The posted comment body is " +
    "prefixed with a visible `[chat: <context>]` tag so the trail is readable directly on " +
    "GitHub, not just in the local audit log.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "The issue or PR number." },
      body: { type: "string", description: "The comment body (Markdown)." },
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "body", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const context = requireContext(args);
    const number = requireNumber(args, "number");
    const body = requireString(args, "body");

    const comment = await postIssueComment(number, tagCommentWithContext(context, body));

    return { ...comment, number };
  },
};

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`"${key}" must be a number`);
  }
  return v;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return v;
}
