import type { ToolDef } from "./registry.ts";
import { resolveRepo } from "../env.ts";
import { fetchRepoTree, githubRequest, type RepoTreeBlob } from "../github.ts";
import { REPO_SCHEMA_PROPERTY } from "./args.ts";

interface CodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    html_url: string;
    text_matches?: Array<{ fragment?: string; property?: string }>;
  }>;
}

/**
 * Real code search across the repo (Git #3697) — the third leg of the
 * file-read capability, for the common case where a chat needs to find where
 * something lives without already knowing the file.
 *
 * TWO real backends, and the result always says which one answered:
 *
 * - `"code-search"` — GitHub's own Code Search API, the primary path. Real
 *   content search, with real matching fragments (hence the
 *   `application/vnd.github.text-match+json` Accept override).
 *
 * - `"repo-tree-paths"` — a real PATH search over the repository's full
 *   recursive git tree, used when code search returns nothing usable. This is
 *   not a nicety: GitHub's legacy code-search index genuinely answers
 *   `total_count: 0` with `incomplete_results: true` for this private repo on
 *   every query tried (verified 2026-09-11 across seven distinct queries and
 *   three repeats, while the identical call against a public repo returned
 *   real hits). Without the fallback this tool would return "no results" for
 *   code that demonstrably exists — a false negative far worse than no tool at
 *   all, because a chat would read it as proof of absence.
 *
 * The fallback matches PATHS, not file contents, and the result says so
 * explicitly in `note` rather than letting a caller assume otherwise. It
 * honours the `path:`, `filename:`, and `extension:` qualifiers meaningfully,
 * ignores qualifiers it genuinely cannot evaluate against a path alone
 * (`language:`, `in:file`, …) and reports them in `ignoredQualifiers`.
 *
 * Read-only, so no `context` argument (Git #3538's convention).
 */
export const searchCodeTool: ToolDef = {
  name: "search_code",
  description:
    "Searches the repository's real code using GitHub's own code-search syntax (e.g. " +
    "'resolveRepo language:ts', 'path:src/tools githubRequest', 'filename:*.sql'). The repo is " +
    "scoped in automatically. Returns each matching file's path, html_url, and — when GitHub's " +
    "code-search index answers — the real matching text fragments. If that index returns nothing " +
    "for the repo (it currently returns nothing at all for shanemccaw/Shane-McCaw-MSP), this " +
    "falls back to a real PATH search over the repository's full git tree and says so in " +
    "`source`/`note`, so an empty result is never mistaken for proof the code doesn't exist. " +
    "Use it to locate a file, then read it with get_file_contents. GitHub's code search indexes " +
    "the DEFAULT BRANCH only; the tree fallback takes an optional `ref`.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A real GitHub code-search query, e.g. 'githubRequest language:ts' or " +
          "'path:artifacts/api-server resolveMspId'. Do not include `repo:` — it is added for you.",
      },
      perPage: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Results per page (default 30, max 100).",
      },
      page: { type: "integer", minimum: 1, description: "1-based page number (default 1)." },
      ref: {
        type: "string",
        description:
          "Optional branch/tag/commit for the git-tree path fallback only (default 'HEAD'). " +
          "GitHub's code-search index ignores it — it only ever indexes the default branch.",
      },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
    if (!rawQuery) throw new Error("search_code requires a non-empty `query`");

    const perPage =
      typeof args.perPage === "number" ? Math.min(Math.max(Math.trunc(args.perPage), 1), 100) : 30;
    const page = typeof args.page === "number" ? Math.max(Math.trunc(args.page), 1) : 1;
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : "HEAD";
    const { owner, repo } = resolveRepo(args.repo);
    const scopedQuery = `repo:${owner}/${repo} ${rawQuery}`;

    const params = new URLSearchParams({
      q: scopedQuery,
      per_page: String(perPage),
      page: String(page),
    });

    let indexed: CodeSearchResponse | null = null;
    let indexError: string | null = null;
    try {
      const { data } = await githubRequest<CodeSearchResponse>(
        "GET",
        `/search/code?${params.toString()}`,
        undefined,
        { accept: "application/vnd.github.text-match+json" },
      );
      indexed = data;
    } catch (err) {
      // A rate-limited or unavailable code-search index is exactly the case the
      // tree fallback exists for — record the real reason and carry on.
      indexError = err instanceof Error ? err.message : String(err);
    }

    if (indexed && indexed.items.length > 0) {
      return {
        source: "code-search",
        query: scopedQuery,
        repo: `${owner}/${repo}`,
        totalCount: indexed.total_count,
        incompleteResults: indexed.incomplete_results,
        page,
        perPage,
        items: indexed.items.map((item) => ({
          name: item.name,
          path: item.path,
          sha: item.sha,
          htmlUrl: item.html_url,
          matches: (item.text_matches ?? [])
            .map((m) => m.fragment)
            .filter((f): f is string => typeof f === "string" && f.length > 0),
        })),
        ignoredQualifiers: [],
        note:
          "Results from GitHub's code-search index, which covers the default branch only. Read a " +
          "hit's real current content with get_file_contents.",
      };
    }

    // --- Fallback: real path search over the repository's own git tree. ---
    const parsed = parseQuery(rawQuery);
    const tree = await fetchRepoTree(ref, { owner, repo });
    const matched = tree.blobs.filter((b) => matchesBlob(b, parsed));
    const start = (page - 1) * perPage;
    const pageItems = matched.slice(start, start + perPage);

    const whyFellBack = indexError
      ? `GitHub's code-search API call failed (${indexError})`
      : indexed && indexed.incomplete_results
        ? "GitHub's code-search index returned no usable results for this repo (incomplete_results: true, total_count: 0) — it does not have this repository indexed"
        : "GitHub's code-search index returned no results for this query";

    return {
      source: "repo-tree-paths",
      query: scopedQuery,
      repo: `${owner}/${repo}`,
      ref: tree.ref,
      totalCount: matched.length,
      incompleteResults: tree.truncated,
      page,
      perPage,
      items: pageItems.map((b) => ({
        name: b.path.slice(b.path.lastIndexOf("/") + 1),
        path: b.path,
        sha: b.sha,
        size: b.size,
        htmlUrl: `https://github.com/${owner}/${repo}/blob/${tree.ref === "HEAD" ? "HEAD" : tree.ref}/${b.path}`,
        matches: [],
      })),
      ignoredQualifiers: parsed.ignoredQualifiers,
      note:
        `${whyFellBack}, so this searched the repository's real git tree instead. ` +
        "IMPORTANT: these matched FILE PATHS, not file contents — an empty result here means no " +
        "path matched, NOT that the code is absent. To search content, list the likely directory " +
        "with list_directory and read candidates with get_file_contents." +
        (parsed.ignoredQualifiers.length
          ? ` Qualifier(s) ${parsed.ignoredQualifiers.join(", ")} cannot be evaluated against a path and were ignored.`
          : "") +
        (tree.truncated ? " GitHub reported the git tree itself as truncated, so this listing is incomplete." : ""),
    };
  },
};

interface ParsedQuery {
  /** Bare terms — every one must appear somewhere in the path (case-insensitive). */
  terms: string[];
  /** `path:` qualifiers — every one must appear in the path. */
  pathTerms: string[];
  /** `filename:` qualifiers — the basename must match (`*` supported). */
  filenamePatterns: string[];
  /** `extension:` qualifiers — the path must end with `.<ext>`. */
  extensions: string[];
  /** Qualifiers a path alone genuinely cannot answer, reported back honestly. */
  ignoredQualifiers: string[];
}

/**
 * Splits a GitHub code-search query into the parts a path search can actually
 * evaluate and the parts it cannot. Quoted phrases are kept whole.
 */
function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    pathTerms: [],
    filenamePatterns: [],
    extensions: [],
    ignoredQualifiers: [],
  };
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const unquoted = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
    const colon = token.startsWith('"') ? -1 : token.indexOf(":");
    if (colon <= 0) {
      if (unquoted) parsed.terms.push(unquoted.toLowerCase());
      continue;
    }
    const key = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1).replace(/^"|"$/g, "");
    if (!value) continue;
    if (key === "path") parsed.pathTerms.push(value.toLowerCase());
    else if (key === "filename") parsed.filenamePatterns.push(value.toLowerCase());
    else if (key === "extension") parsed.extensions.push(value.replace(/^\./, "").toLowerCase());
    else if (key === "repo") continue; // already scoped for the caller
    else parsed.ignoredQualifiers.push(`${key}:${value}`);
  }
  return parsed;
}

function matchesBlob(blob: RepoTreeBlob, q: ParsedQuery): boolean {
  const path = blob.path.toLowerCase();
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!q.pathTerms.every((t) => path.includes(t))) return false;
  if (q.extensions.length && !q.extensions.some((e) => base.endsWith(`.${e}`))) return false;
  if (q.filenamePatterns.length && !q.filenamePatterns.some((p) => globMatch(base, p))) return false;
  if (!q.terms.every((t) => path.includes(t))) return false;
  // A query made entirely of qualifiers this fallback can't evaluate would
  // otherwise match every file in the repo — that is noise, not a result.
  return q.terms.length > 0 || q.pathTerms.length > 0 || q.filenamePatterns.length > 0 || q.extensions.length > 0;
}

/** `*`-only glob match, anchored — what `filename:` qualifiers actually use. */
function globMatch(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern || value.includes(pattern);
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
