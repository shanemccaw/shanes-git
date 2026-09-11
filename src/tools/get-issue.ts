import type { ToolDef } from "./registry.ts";
import { githubRequest, normalizeIssue, repoPath, type RawGitHubIssue } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { REPO_SCHEMA_PROPERTY } from "./args.ts";

/** Reads one issue (or PR — GitHub serves both from the same endpoint) by number. */
export const getIssueTool: ToolDef = {
  name: "get_issue",
  description:
    "Fetches one GitHub issue by number. Returns its full normalized state — title, body, " +
    "labels, milestone, assignees, state, comment count, timestamps. Optional `repo` (Git #3580) " +
    "targets a different repo; defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The issue number." },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = typeof args.number === "number" ? args.number : Number(args.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("get_issue requires a positive integer `number`");
    }
    const repo = resolveRepo(args.repo);
    const { data } = await githubRequest<RawGitHubIssue>("GET", `${repoPath(repo)}/issues/${number}`);
    return normalizeIssue(data);
  },
};
