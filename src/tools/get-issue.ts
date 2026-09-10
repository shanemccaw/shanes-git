import type { ToolDef } from "./registry.ts";
import { githubRequest, normalizeIssue, repoPath, type RawGitHubIssue } from "../github.ts";

/** Reads one issue (or PR — GitHub serves both from the same endpoint) by number. */
export const getIssueTool: ToolDef = {
  name: "get_issue",
  description:
    "Fetches one GitHub issue by number from this repo. Returns its full normalized state — " +
    "title, body, labels, milestone, assignees, state, comment count, timestamps.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The issue number." },
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = typeof args.number === "number" ? args.number : Number(args.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("get_issue requires a positive integer `number`");
    }
    const { data } = await githubRequest<RawGitHubIssue>("GET", `${repoPath()}/issues/${number}`);
    return normalizeIssue(data);
  },
};
