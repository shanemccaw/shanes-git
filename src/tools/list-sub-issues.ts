import type { ToolDef } from "./registry.ts";
import { listSubIssues } from "../github.ts";
import { requireInt } from "./args.ts";

/** list_sub_issues(number) — the real, current sub-issue tree of one issue. */
export const listSubIssuesTool: ToolDef = {
  name: "list_sub_issues",
  description:
    "Lists the real sub-issues of `number` — number/id/title/state/html_url for each, in GitHub's " +
    "own order.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The parent issue number." },
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = requireInt(args.number, "number");
    const subIssues = await listSubIssues(number);
    return { number, count: subIssues.length, subIssues };
  },
};
