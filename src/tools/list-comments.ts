import type { ToolDef } from "./registry.ts";
import { listIssueComments } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { REPO_SCHEMA_PROPERTY } from "./args.ts";

/**
 * Lists an issue/PR's comments, oldest first — matching the standing
 * convention (this repo's CLAUDE.md) that a later comment may supersede an
 * earlier one's stated state, so callers need real chronological order, not
 * whatever order the API happens to return.
 */
export const listCommentsTool: ToolDef = {
  name: "list_comments",
  description:
    "Lists all comments on a GitHub issue (or PR) in order, oldest first. Returns id, author, " +
    "body, htmlUrl, createdAt, updatedAt for each. Optional `repo` (Git #3580) targets a " +
    "different repo; defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "The issue or PR number." },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = requireNumber(args, "number");
    const repo = resolveRepo(args.repo);
    const comments = await listIssueComments(number, repo);
    return { number, count: comments.length, comments };
  },
};

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`"${key}" must be a number`);
  }
  return v;
}
