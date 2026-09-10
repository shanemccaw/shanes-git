import { createHash, randomBytes } from "node:crypto";
import { query } from "./db.ts";
import { logger } from "./logger.ts";

/**
 * Bearer tokens for the GitHub MCP server — the credential a Claude conversation
 * presents to reach this server, NOT the GitHub PAT (which never leaves the
 * server's env). Same discipline as Shane's Life's own mcp_tokens: a
 * high-entropy value handed out exactly once, only its SHA-256 fingerprint
 * stored. A token is labeled, revocable, and every call it makes lands in the
 * Recent-Activity trail with that label attached — so "which Claude connection
 * did this" has a real answer.
 */

export const TOKEN_PREFIX = "ghmcp_";

/** 32 random bytes, base64url — not guessable, URL-safe. */
function mintSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Only the SHA-256 hex of a token is ever written to the database. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export interface IssuedToken {
  id: number;
  label: string;
  createdAt: Date;
  /** The plaintext token — returned ONCE at mint, never stored, never re-derivable. */
  token: string;
}

export async function issueToken(label: string): Promise<IssuedToken> {
  const token = mintSecret();
  const { rows } = await query<{ id: number; label: string; created_at: Date }>(
    `INSERT INTO github_mcp_tokens (token_hash, label)
     VALUES ($1, $2)
     RETURNING id, label, created_at`,
    [fingerprint(token), String(label || "unnamed").slice(0, 120)],
  );
  const row = rows[0];
  logger.info({ tokenId: row.id, label: row.label }, "minted MCP bearer token");
  return { id: row.id, label: row.label, createdAt: row.created_at, token };
}

export interface ResolvedToken {
  tokenId: number;
  label: string;
}

/**
 * Resolves an incoming bearer token to its row, or null if unknown/revoked.
 * The lookup is by SHA-256 fingerprint against a unique index — the plaintext
 * is never compared, and the same-shaped answer is returned for both "no such
 * token" and "revoked" so a caller learns nothing extra from the difference.
 * On a hit, bumps last_used_at / call_count.
 */
export async function resolveToken(token: string | null): Promise<ResolvedToken | null> {
  if (!token) return null;
  const { rows } = await query<{ id: number; label: string }>(
    `SELECT id, label
       FROM github_mcp_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
      LIMIT 1`,
    [fingerprint(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await query(
    `UPDATE github_mcp_tokens SET last_used_at = now(), call_count = call_count + 1 WHERE id = $1`,
    [row.id],
  );
  return { tokenId: row.id, label: row.label };
}

export interface TokenSummary {
  id: number;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  callCount: number;
}

export async function listTokens(): Promise<TokenSummary[]> {
  const { rows } = await query<{
    id: number;
    label: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
    call_count: number;
  }>(
    `SELECT id, label, created_at, last_used_at, revoked_at, call_count
       FROM github_mcp_tokens
      ORDER BY created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    callCount: r.call_count,
  }));
}

/** Revokes a token by id. Returns true if a live token was revoked, false if it
 *  did not exist or was already revoked. The row is kept (not deleted) so the
 *  activity trail's FK stays intact. */
export async function revokeToken(id: number): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE github_mcp_tokens SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  if (rowCount && rowCount > 0) {
    logger.info({ tokenId: id }, "revoked MCP bearer token");
    return true;
  }
  return false;
}
