import { githubApiBaseUrl, githubPat, githubRepo } from "./env.ts";

/**
 * The server-side GitHub client. The PAT is read from the environment
 * (githubPat()) and attached as the Authorization header INTERNALLY on every
 * request — it is never accepted as a tool argument, never returned in a
 * result, and never logged. This module is the ONE place the token is touched;
 * every sibling tool (create_issue, add_sub_issue, …) calls githubRequest()
 * rather than handling the credential itself.
 */

const USER_AGENT = "shane-msp-github-mcp/0.1.0";

export class GitHubError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string, message: string) {
    super(`GitHub ${status} on ${path}: ${message}`);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
  }
}

/** Thrown when a tool needs the PAT but none is configured — the auth/scaffold
 *  half of the server still runs without it, so this is a clean, honest refusal
 *  rather than a boot crash. */
export class PatNotConfiguredError extends Error {
  constructor() {
    super(
      "No GitHub PAT is configured server-side. Set GITHUB_MCP_PAT (or GIT_PAT) in the " +
        "repo-root .env.local or the environment. The token is held server-side only and is " +
        "never passed through chat.",
    );
    this.name = "PatNotConfiguredError";
  }
}

export function isPatConfigured(): boolean {
  return githubPat() !== null;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  /** OAuth/PAT scopes GitHub reports for the token, from x-oauth-scopes. Never includes the token. */
  scopes: string[];
}

/**
 * Makes one authenticated GitHub REST call with the server-side PAT. `path` is
 * appended to the API base (e.g. "/user", "/repos/o/r/issues"). Returns parsed
 * JSON plus the token's reported scopes. Throws GitHubError on any non-2xx,
 * with the PAT scrubbed from the message defensively.
 *
 * `options.accept` overrides the default `application/vnd.github+json` Accept
 * header for the endpoints that genuinely need a different media type — today
 * only `search_code`, which asks for `…text-match+json` to get real matched
 * fragments back (Git #3697). The response is still parsed as JSON; this is not
 * an escape hatch for raw/binary bodies.
 */
export async function githubRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: { accept?: string },
): Promise<GitHubResponse<T>> {
  const pat = githubPat();
  if (!pat) throw new PatNotConfiguredError();

  const url = path.startsWith("http") ? path : `${githubApiBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: options?.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // A network failure must never surface the token in its message.
    throw new GitHubError(0, path, scrub(err instanceof Error ? err.message : String(err), pat));
  }

  const scopes = (res.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : res.statusText;
    throw new GitHubError(res.status, path, scrub(message, pat));
  }

  return { status: res.status, data: data as T, scopes };
}

/** Belt-and-braces: replace any accidental occurrence of the PAT in a string. */
function scrub(text: string, pat: string): string {
  return pat ? text.split(pat).join("[redacted-pat]") : text;
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * The GraphQL twin of githubRequest() — same server-side-only PAT, same
 * never-log-it discipline. Projects v2 (board columns) has no REST surface at
 * all; every board read/write goes through this. Throws GitHubError (status 0
 * for a GraphQL-level error array, since there's no meaningful HTTP status to
 * attach) with the PAT scrubbed from the message.
 */
export async function githubGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const pat = githubPat();
  if (!pat) throw new PatNotConfiguredError();

  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new GitHubError(0, "graphql", scrub(err instanceof Error ? err.message : String(err), pat));
  }

  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new GitHubError(res.ok ? 0 : res.status, "graphql", scrub(message, pat));
  }
  return body.data as T;
}

export interface GitHubViewer {
  login: string;
  id: number;
  htmlUrl: string;
  type: string;
  scopes: string[];
}

/**
 * The authenticated user behind the server-side PAT — proves the token works
 * without ever revealing it. Returns only public identity fields + scopes.
 */
export async function getViewer(): Promise<GitHubViewer> {
  const { data, scopes } = await githubRequest<{
    login: string;
    id: number;
    html_url: string;
    type: string;
  }>("GET", "/user");
  return {
    login: data.login,
    id: data.id,
    htmlUrl: data.html_url,
    type: data.type,
    scopes,
  };
}

/**
 * `/repos/{owner}/{repo}` path prefix. `override` (Git #3580) lets a caller
 * target a specific repo for this one call; omitted falls back to the
 * existing GITHUB_MCP_REPO/default via `githubRepo()`.
 */
export function repoPath(override?: { owner: string; repo: string }): string {
  const { owner, repo } = override ?? githubRepo();
  return `/repos/${owner}/${repo}`;
}

export interface GitHubIssueSummary {
  number: number;
  htmlUrl: string;
  state: string;
  stateReason: string | null;
}

/**
 * Posts a comment on an issue. Returns the comment's own URL so a caller (e.g.
 * close_issue) can prove the comment landed before the state change that
 * depends on it.
 */
export async function postIssueComment(
  issueNumber: number,
  body: string,
  repo?: { owner: string; repo: string },
): Promise<{ id: number; htmlUrl: string; createdAt: string }> {
  const { data } = await githubRequest<{ id: number; html_url: string; created_at: string }>(
    "POST",
    `${repoPath(repo)}/issues/${issueNumber}/comments`,
    { body },
  );
  return { id: data.id, htmlUrl: data.html_url, createdAt: data.created_at };
}

export interface GitHubComment {
  id: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  body: string;
}

/**
 * Lists every comment on an issue/PR, oldest first (GitHub's own default order
 * for this endpoint), paginating through all pages rather than trusting a
 * single page for issues with a long history.
 */
export async function listIssueComments(
  issueNumber: number,
  repoOverride?: { owner: string; repo: string },
): Promise<GitHubComment[]> {
  const { owner, repo } = repoOverride ?? githubRepo();
  const comments: GitHubComment[] = [];
  const perPage = 100;
  for (let page = 1; page < 1000; page++) {
    const { data } = await githubRequest<
      Array<{
        id: number;
        html_url: string;
        created_at: string;
        updated_at: string;
        user: { login: string } | null;
        body: string | null;
      }>
    >(
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}&sort=created&direction=asc`,
    );
    comments.push(
      ...data.map((c) => ({
        id: c.id,
        htmlUrl: c.html_url,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        author: c.user?.login ?? null,
        body: c.body ?? "",
      })),
    );
    if (data.length < perPage) break;
  }
  return comments;
}

/**
 * Closes an issue with a real state_reason. Callers enforce the NOT_PLANNED
 * comment rule BEFORE calling this — this function only performs the close.
 */
export async function closeIssue(
  issueNumber: number,
  stateReason: "completed" | "not_planned",
  repo?: { owner: string; repo: string },
): Promise<GitHubIssueSummary> {
  const { data } = await githubRequest<{
    number: number;
    html_url: string;
    state: string;
    state_reason: string | null;
  }>("PATCH", `${repoPath(repo)}/issues/${issueNumber}`, {
    state: "closed",
    state_reason: stateReason,
  });
  return {
    number: data.number,
    htmlUrl: data.html_url,
    state: data.state,
    stateReason: data.state_reason,
  };
}

export interface IssueSummary {
  number: number;
  id: number;
  title: string;
  state: string;
  htmlUrl: string;
}

/**
 * Resolves an issue's real internal `id` (NOT its `node_id`, NOT its `number`) —
 * the sub-issue and dependency APIs both key off this, and a caller only ever
 * hands this server a plain issue number.
 */
export async function getIssueSummary(
  number: number,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary> {
  const { data } = await githubRequest<{
    number: number;
    id: number;
    title: string;
    state: string;
    html_url: string;
  }>("GET", `${repoPath(repo)}/issues/${number}`);
  return { number: data.number, id: data.id, title: data.title, state: data.state, htmlUrl: data.html_url };
}

/** Real sub-issues of `number`, in GitHub's own order. */
export async function listSubIssues(
  number: number,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary[]> {
  const { data } = await githubRequest<
    Array<{ number: number; id: number; title: string; state: string; html_url: string }>
  >("GET", `${repoPath(repo)}/issues/${number}/sub_issues`);
  return data.map((d) => ({ number: d.number, id: d.id, title: d.title, state: d.state, htmlUrl: d.html_url }));
}

/**
 * Adds `childNumber` as a sub-issue of `parentNumber`. Resolves the child's real
 * `id` internally — the caller only ever passes issue numbers. Per GitHub's own
 * one-parent-at-a-time rule, a child already parented elsewhere must be removed
 * from its old parent first (see removeSubIssue) or this call fails. `repo`
 * (Git #3580) is applied to both the parent and child lookups — a single call
 * targets one repo, not a cross-repo pairing.
 */
export async function addSubIssue(
  parentNumber: number,
  childNumber: number,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary[]> {
  const child = await getIssueSummary(childNumber, repo);
  await githubRequest("POST", `${repoPath(repo)}/issues/${parentNumber}/sub_issues`, { sub_issue_id: child.id });
  return listSubIssues(parentNumber, repo);
}

/** Removes `childNumber` as a sub-issue of `parentNumber` (for re-parenting). */
export async function removeSubIssue(
  parentNumber: number,
  childNumber: number,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary[]> {
  const child = await getIssueSummary(childNumber, repo);
  await githubRequest("DELETE", `${repoPath(repo)}/issues/${parentNumber}/sub_issue`, { sub_issue_id: child.id });
  return listSubIssues(parentNumber, repo);
}

/** Real current `blocked_by` edges for `number` — who it's actually waiting on, with live state. */
export async function listBlockedBy(
  number: number,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary[]> {
  const { data } = await githubRequest<
    Array<{ number: number; id: number; title: string; state: string; html_url: string }>
  >("GET", `${repoPath(repo)}/issues/${number}/dependencies/blocked_by`);
  return data.map((d) => ({ number: d.number, id: d.id, title: d.title, state: d.state, htmlUrl: d.html_url }));
}

/** Adds one real `blocked_by` edge from `number` to `blockerNumber`. */
export async function addBlockedBy(
  number: number,
  blockerNumber: number,
  repo?: { owner: string; repo: string },
): Promise<void> {
  const blocker = await getIssueSummary(blockerNumber, repo);
  await githubRequest("POST", `${repoPath(repo)}/issues/${number}/dependencies/blocked_by`, { issue_id: blocker.id });
}

/** Removes one real `blocked_by` edge from `number` to `blockerNumber`. */
export async function removeBlockedBy(
  number: number,
  blockerNumber: number,
  repo?: { owner: string; repo: string },
): Promise<void> {
  const blocker = await getIssueSummary(blockerNumber, repo);
  await githubRequest("DELETE", `${repoPath(repo)}/issues/${number}/dependencies/blocked_by/${blocker.id}`);
}

/** The raw shape GitHub's REST API returns for an issue (the fields these tools use). */
export interface RawGitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  html_url: string;
  user: { login: string } | null;
  labels: Array<string | { name?: string }>;
  milestone: { number: number; title: string } | null;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  pull_request?: unknown;
}

/** The normalized shape every issue tool in this server returns to a chat. */
export interface NormalizedIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  stateReason: string | null;
  htmlUrl: string;
  author: string | null;
  labels: string[];
  milestone: { number: number; title: string } | null;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentCount: number;
  isPullRequest: boolean;
}

export function normalizeIssue(raw: RawGitHubIssue): NormalizedIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    stateReason: raw.state_reason,
    htmlUrl: raw.html_url,
    author: raw.user?.login ?? null,
    labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    milestone: raw.milestone ? { number: raw.milestone.number, title: raw.milestone.title } : null,
    assignees: raw.assignees.map((a) => a.login),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    commentCount: raw.comments,
    isPullRequest: raw.pull_request !== undefined,
  };
}

/* ------------------------------------------------------------------------- *
 * Repository contents (Git #3697)
 *
 * Everything below reads real repository CODE rather than issue/board
 * metadata. Same server-side-only PAT, same never-log-it discipline — the
 * private repo is readable here precisely because the PAT lives on the server
 * and never crosses into chat.
 * ------------------------------------------------------------------------- */

/**
 * GitHub's own inline-content ceiling on the Contents API. At or under this the
 * API returns real base64 `content`; above it the same call returns the entry's
 * metadata with `content: ""` and `encoding: "none"`, which is what
 * get_file_contents reports honestly as "too large" rather than as empty text.
 * Documented at https://docs.github.com/rest/repos/contents.
 */
export const CONTENTS_INLINE_MAX_BYTES = 1024 * 1024;

/** GitHub's own cap on how many entries one Contents directory listing returns. */
export const CONTENTS_DIRECTORY_MAX_ENTRIES = 1000;

/** One entry exactly as GitHub's Contents API returns it (the fields used here). */
export interface RawContentEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string | null;
  download_url: string | null;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
}

/**
 * Normalizes a repo path for the Contents API: strips leading/trailing slashes
 * and `./`, collapses duplicate separators, and percent-encodes each segment
 * individually so a real path containing spaces or `#` survives while the `/`
 * separators stay separators. Rejects `..` outright — the Contents API would
 * resolve it server-side and there is no legitimate reason a chat needs it.
 */
export function encodeContentsPath(rawPath: string): string {
  const cleaned = rawPath
    .split("\\")
    .join("/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  const segments = cleaned.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`path must not contain ".." segments, got: ${rawPath}`);
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * One real Contents API call. Returns an array for a directory and a single
 * object for a file — GitHub's own shape, handed back unchanged so the two
 * calling tools can each reject the wrong one with a useful message instead of
 * guessing. A 404 is rethrown with the real path/ref named, because GitHub's
 * own "Not Found" alone doesn't say which of the two was wrong.
 */
export async function fetchContents(
  path: string,
  ref: string | undefined,
  repo?: { owner: string; repo: string },
): Promise<RawContentEntry | RawContentEntry[]> {
  const encoded = encodeContentsPath(path);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const { data } = await githubRequest<RawContentEntry | RawContentEntry[]>(
      "GET",
      `${repoPath(repo)}/contents/${encoded}${query}`,
    );
    return data;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      const { owner, repo: name } = repo ?? githubRepo();
      throw new Error(
        `No such path "${path || "/"}" in ${owner}/${name}` +
          (ref ? ` at ref "${ref}"` : " on the default branch") +
          ". Check the path (it is case-sensitive and repo-root-relative) or list its parent " +
          "directory with list_directory first.",
      );
    }
    throw err;
  }
}

/** The normalized directory/entry shape both contents tools return to a chat. */
export interface ContentEntrySummary {
  name: string;
  path: string;
  type: RawContentEntry["type"];
  size: number;
  sha: string;
  htmlUrl: string | null;
  downloadUrl: string | null;
}

export function normalizeContentEntry(raw: RawContentEntry): ContentEntrySummary {
  return {
    name: raw.name,
    path: raw.path,
    type: raw.type,
    size: raw.size,
    sha: raw.sha,
    htmlUrl: raw.html_url,
    downloadUrl: raw.download_url,
  };
}

/**
 * True when a decoded blob is not real text — a NUL byte in the first 8 KiB is
 * git's own heuristic for the same question. Handing a chat the UTF-8
 * mis-decoding of a PNG would be worse than saying plainly that it's binary.
 */
export function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8192));
  return window.includes(0);
}

/** One blob in the repo's real recursive git tree. */
export interface RepoTreeBlob {
  path: string;
  sha: string;
  size: number;
}

export interface RepoTree {
  /** The commit/tree ref this listing was taken at. */
  ref: string;
  blobs: RepoTreeBlob[];
  /** GitHub's own flag: the tree was too large to return in full. */
  truncated: boolean;
}

const treeCache = new Map<string, { fetchedAt: number; tree: RepoTree }>();
const TREE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The repo's whole file list in ONE call — `GET /git/trees/{ref}?recursive=1`.
 *
 * This exists because GitHub's legacy Code Search index genuinely returns
 * nothing for this repository (Git #3697: `incomplete_results: true` with
 * `total_count: 0` on every query tried, while the identical call against a
 * public repo returns real hits). The tree endpoint has no such index
 * dependency — it reads git objects directly — so it is what makes
 * `search_code` able to answer anything at all here.
 *
 * Cached in-process for five minutes per (repo, ref): the response for this
 * repo is ~7,000 entries, and re-fetching it on every search would be a real
 * bandwidth cost for a listing that changes only when someone pushes.
 */
export async function fetchRepoTree(
  ref: string,
  repo?: { owner: string; repo: string },
): Promise<RepoTree> {
  const { owner, repo: name } = repo ?? githubRepo();
  const key = `${owner}/${name}@${ref}`;
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TREE_CACHE_TTL_MS) return cached.tree;

  const { data } = await githubRequest<{
    truncated: boolean;
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  }>("GET", `${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);

  const tree: RepoTree = {
    ref,
    truncated: data.truncated === true,
    blobs: data.tree
      .filter((e) => e.type === "blob")
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
  };
  treeCache.set(key, { fetchedAt: Date.now(), tree });
  return tree;
}
