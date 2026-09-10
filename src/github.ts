import { githubApiBaseUrl, githubPat } from "./env.ts";

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
