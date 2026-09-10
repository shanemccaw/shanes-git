import type { ToolDef } from "./registry.ts";
import { githubRepo } from "../env.ts";
import { githubRequest, normalizeIssue, type RawGitHubIssue } from "../github.ts";

interface SearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: RawGitHubIssue[];
}

/**
 * Real passthrough to GitHub's own search — the query string is GitHub's own
 * search syntax (`is:open label:bug`, `milestone:"v1.1"`, free text, etc.),
 * unmodified, with `repo:<owner>/<repo>` scoped onto it automatically so a
 * caller doesn't have to repeat it. Same result shape GitHub's own search API
 * returns (`total_count` + normalized `items`), per the issue's own spec.
 */
export const searchIssuesTool: ToolDef = {
  name: "search_issues",
  description:
    "Searches issues and PRs in this repo using GitHub's own search query syntax " +
    "(e.g. 'is:open label:bug', 'milestone:\"v1.1\" is:issue', free text). The repo is scoped " +
    "in automatically. Returns total_count and the matching issues (normalized), same shape as " +
    "GitHub's own search.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A real GitHub search query, e.g. 'is:open label:bug'." },
      perPage: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 30, max 100)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
    if (!rawQuery) throw new Error("search_issues requires a non-empty `query`");

    const perPage = typeof args.perPage === "number" ? Math.min(Math.max(Math.trunc(args.perPage), 1), 100) : 30;
    const { owner, repo } = githubRepo();
    const scopedQuery = `repo:${owner}/${repo} ${rawQuery}`;
    const params = new URLSearchParams({ q: scopedQuery, per_page: String(perPage) });

    const { data } = await githubRequest<SearchResponse>("GET", `/search/issues?${params.toString()}`);
    return {
      totalCount: data.total_count,
      incompleteResults: data.incomplete_results,
      items: data.items.map(normalizeIssue),
    };
  },
};
