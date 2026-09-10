import type { ToolDef } from "./registry.ts";
import { postIssueComment } from "../github.ts";

/**
 * Posts a real comment on a real issue — this is the mechanism the standing
 * "mandatory: comment on the issue before finishing" / BUILD: header / bookend
 * conventions all rely on. The comment body is passed through verbatim; the
 * caller (the model) is responsible for the standing conventions (Posted:
 * timestamp, findings list, etc.) — this tool has no opinion on shape. Shares
 * `postIssueComment()` in github.ts with `close_issue`'s NOT_PLANNED-comment
 * enforcement (Git #3394).
 */
export const postCommentTool: ToolDef = {
  name: "post_comment",
  description:
    "Posts a comment on a GitHub issue (or PR — same numbering) in the repo this server is " +
    "configured for. Returns the created comment's id, htmlUrl, and createdAt. Body is posted " +
    "verbatim.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "The issue or PR number." },
      body: { type: "string", description: "The comment body (Markdown), posted verbatim." },
    },
    required: ["number", "body"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = requireNumber(args, "number");
    const body = requireString(args, "body");

    const comment = await postIssueComment(number, body);

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
