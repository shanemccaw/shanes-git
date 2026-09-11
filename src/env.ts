import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the repo-root .env.local into process.env. Already-set variables win,
 * so a real environment override always beats the file. This server is its own
 * process — it does not inherit the api-server's env — but it reads the SAME
 * DATABASE_URL the local api-server runs with, plus the server-side GitHub PAT,
 * and the repo-root .env.local is where those live for local dev.
 */
export function loadEnvLocal(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      applyEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No .env.local found — rely on the ambient environment (e.g. a deploy where
  // the secrets come from the environment itself).
}

function applyEnvFile(path: string): void {
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required but not set — expected in the repo-root .env.local or the environment`,
    );
  }
  return value;
}

/**
 * The server-side GitHub PAT. Read from the environment ONLY, and consumed
 * internally by the GitHub client — it is never returned in a tool result, a
 * log line, or an audit row. Prefers a dedicated GITHUB_MCP_PAT if set, else
 * the repo's existing GIT_PAT (the same fallback the rest of the codebase uses
 * — see the GITHUB_MCP 403 memory). Returns null when neither is set, so the
 * server can come up and report "PAT not configured" honestly rather than
 * crashing — the auth+scaffold half still works without it.
 */
export function githubPat(): string | null {
  return process.env.GITHUB_MCP_PAT ?? process.env.GIT_PAT ?? null;
}

/** The GitHub API base. Overridable for GitHub Enterprise; defaults to public github.com. */
export function githubApiBaseUrl(): string {
  return process.env.GITHUB_MCP_API_BASE_URL ?? "https://api.github.com";
}

/** Parses an "owner/repo" string, throwing with `label` in the message if it's malformed. */
function parseOwnerRepo(raw: string, label: string): { owner: string; repo: string } {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`${label} must be "owner/repo", got: ${raw}`);
  }
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

/**
 * The repo this server's tools operate against by default — "owner/repo".
 * Overridable via GITHUB_MCP_REPO for a fork/test repo; defaults to this
 * codebase's own repo. As of Git #3580, this is the *fallback* a tool call
 * resolves to when it doesn't supply its own `repo` argument — see
 * `resolveRepo()` — not the only repo the server can ever address.
 */
export function githubRepo(): { owner: string; repo: string } {
  const raw = process.env.GITHUB_MCP_REPO ?? "shanemccaw/Shane-McCaw-MSP";
  return parseOwnerRepo(raw, "GITHUB_MCP_REPO");
}

/**
 * Resolves the real repo one tool call should operate against (Git #3580) —
 * the caller-supplied `repo` tool argument ("owner/repo") if present and
 * non-empty, else the existing GITHUB_MCP_REPO/default fallback. Validates
 * the "owner/repo" shape and rejects a malformed value BEFORE any GitHub call
 * is made, same discipline `githubRepo()`'s own env-var validation already
 * uses. An omitted/empty `repo` arg is full backward compatibility — every
 * existing call site keeps resolving to exactly what it did before this.
 */
export function resolveRepo(repoArg: unknown): { owner: string; repo: string } {
  if (typeof repoArg !== "string" || !repoArg.trim()) return githubRepo();
  return parseOwnerRepo(repoArg.trim(), "repo");
}

/** Host to bind the HTTP listener to. Loopback by default — this is a local operator tool. */
export function serverHost(): string {
  return process.env.GITHUB_MCP_HOST ?? "127.0.0.1";
}

/** Port the MCP HTTP endpoint listens on. */
export function serverPort(): number {
  const raw = process.env.GITHUB_MCP_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8770;
}
