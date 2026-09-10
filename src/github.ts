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
 */
export async function githubRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
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
        Accept: "application/vnd.github+json",
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
): Promise<{ id: number; htmlUrl: string; createdAt: string }> {
  const { owner, repo } = githubRepo();
  const { data } = await githubRequest<{ id: number; html_url: string; created_at: string }>(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
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
export async function listIssueComments(issueNumber: number): Promise<GitHubComment[]> {
  const { owner, repo } = githubRepo();
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
): Promise<GitHubIssueSummary> {
  const { owner, repo } = githubRepo();
  const { data } = await githubRequest<{
    number: number;
    html_url: string;
    state: string;
    state_reason: string | null;
  }>("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, {
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

/** Builds a `/repos/{owner}/{repo}/...` path against the server's configured repo. */
function repoPath(path: string): string {
  const { owner, repo } = githubRepo();
  return `/repos/${owner}/${repo}${path}`;
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
export async function getIssueSummary(number: number): Promise<IssueSummary> {
  const { data } = await githubRequest<{
    number: number;
    id: number;
    title: string;
    state: string;
    html_url: string;
  }>("GET", repoPath(`/issues/${number}`));
  return { number: data.number, id: data.id, title: data.title, state: data.state, htmlUrl: data.html_url };
}

/** Real sub-issues of `number`, in GitHub's own order. */
export async function listSubIssues(number: number): Promise<IssueSummary[]> {
  const { data } = await githubRequest<
    Array<{ number: number; id: number; title: string; state: string; html_url: string }>
  >("GET", repoPath(`/issues/${number}/sub_issues`));
  return data.map((d) => ({ number: d.number, id: d.id, title: d.title, state: d.state, htmlUrl: d.html_url }));
}

/**
 * Adds `childNumber` as a sub-issue of `parentNumber`. Resolves the child's real
 * `id` internally — the caller only ever passes issue numbers. Per GitHub's own
 * one-parent-at-a-time rule, a child already parented elsewhere must be removed
 * from its old parent first (see removeSubIssue) or this call fails.
 */
export async function addSubIssue(parentNumber: number, childNumber: number): Promise<IssueSummary[]> {
  const child = await getIssueSummary(childNumber);
  await githubRequest("POST", repoPath(`/issues/${parentNumber}/sub_issues`), { sub_issue_id: child.id });
  return listSubIssues(parentNumber);
}

/** Removes `childNumber` as a sub-issue of `parentNumber` (for re-parenting). */
export async function removeSubIssue(parentNumber: number, childNumber: number): Promise<IssueSummary[]> {
  const child = await getIssueSummary(childNumber);
  await githubRequest("DELETE", repoPath(`/issues/${parentNumber}/sub_issue`), { sub_issue_id: child.id });
  return listSubIssues(parentNumber);
}

/** Real current `blocked_by` edges for `number` — who it's actually waiting on, with live state. */
export async function listBlockedBy(number: number): Promise<IssueSummary[]> {
  const { data } = await githubRequest<
    Array<{ number: number; id: number; title: string; state: string; html_url: string }>
  >("GET", repoPath(`/issues/${number}/dependencies/blocked_by`));
  return data.map((d) => ({ number: d.number, id: d.id, title: d.title, state: d.state, htmlUrl: d.html_url }));
}

/** Adds one real `blocked_by` edge from `number` to `blockerNumber`. */
export async function addBlockedBy(number: number, blockerNumber: number): Promise<void> {
  const blocker = await getIssueSummary(blockerNumber);
  await githubRequest("POST", repoPath(`/issues/${number}/dependencies/blocked_by`), { issue_id: blocker.id });
}

/** Removes one real `blocked_by` edge from `number` to `blockerNumber`. */
export async function removeBlockedBy(number: number, blockerNumber: number): Promise<void> {
  const blocker = await getIssueSummary(blockerNumber);
  await githubRequest("DELETE", repoPath(`/issues/${number}/dependencies/blocked_by/${blocker.id}`));
}
