import type { ToolDef } from "./registry.ts";
import { listSubIssues } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { REPO_SCHEMA_PROPERTY, requireInt } from "./args.ts";

/** list_sub_issues(number) — the real, current sub-issue tree of one issue. */
export const listSubIssuesTool: ToolDef = {
  name: "list_sub_issues",
  description:
    "Lists the real sub-issues of `number` — number/id/title/state/html_url for each, in GitHub's " +
    "own order. Optional `repo` (Git #3580) targets a different repo; defaults to the server's " +
    "configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The parent issue number." },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = requireInt(args.number, "number");
    const repo = resolveRepo(args.repo);
    const subIssues = await listSubIssues(number, repo);
    return { number, count: subIssues.length, subIssues };
  },
};
