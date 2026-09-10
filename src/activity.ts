import { query } from "./db.ts";
import { auditLogger } from "./logger.ts";

/**
 * The Recent-Activity trail (Git #3390 / Feature #3377's Audit scope). One row
 * per MCP tool call — which token, which tool, the (redacted) params, and the
 * outcome — so Shane can see exactly what each Claude connection has done, the
 * same spirit as Shane's Life's Settings → Recent Activity.
 *
 * The GitHub PAT is NEVER written here. Params flow through redactParams() so a
 * tool arg carrying a secret is masked before the row is inserted. Recording is
 * best-effort: an audit-write failure is logged loudly but never fails the tool
 * call it describes (a read tool's answer is still returned; a scaffold with no
 * write tools yet has nothing to fail closed on).
 */

const PARAMS_JSON_CAP = 8_000;

export interface ActivityInput {
  tokenId: number | null;
  tokenLabel: string | null;
  tool: string;
  params: Record<string, unknown>;
  outcome: "success" | "failure";
  detail?: string | null;
  durationMs?: number | null;
  /** Arg names to mask to "[redacted]" in the stored params — a secret's value never persists. */
  redactParams?: string[];
}

export async function recordActivity(input: ActivityInput): Promise<void> {
  const params = capParams(redact(input.params, input.redactParams));
  try {
    await query(
      `INSERT INTO github_mcp_activity
         (token_id, token_label, tool, params, outcome, detail, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        input.tokenId,
        input.tokenLabel,
        input.tool,
        JSON.stringify(params),
        input.outcome,
        input.detail ?? null,
        input.durationMs ?? null,
      ],
    );
    auditLogger.info(
      { tokenId: input.tokenId, tool: input.tool, outcome: input.outcome },
      "MCP activity recorded",
    );
  } catch (err) {
    auditLogger.error(
      {
        tool: input.tool,
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
      "failed to record MCP activity (best-effort; tool result still returned)",
    );
  }
}

export interface ActivityRow {
  id: number;
  tokenId: number | null;
  tokenLabel: string | null;
  tool: string;
  params: Record<string, unknown> | null;
  outcome: string;
  detail: string | null;
  durationMs: number | null;
  createdAt: string;
}

export async function listActivity(limit: number): Promise<ActivityRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
  const { rows } = await query<{
    id: number;
    token_id: number | null;
    token_label: string | null;
    tool: string;
    params: Record<string, unknown> | null;
    outcome: string;
    detail: string | null;
    duration_ms: number | null;
    created_at: Date;
  }>(
    `SELECT id, token_id, token_label, tool, params, outcome, detail, duration_ms, created_at
       FROM github_mcp_activity
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [capped],
  );
  return rows.map((r) => ({
    id: r.id,
    tokenId: r.token_id,
    tokenLabel: r.token_label,
    tool: r.tool,
    params: r.params,
    outcome: r.outcome,
    detail: r.detail,
    durationMs: r.duration_ms,
    createdAt: r.created_at.toISOString(),
  }));
}

function redact(
  params: Record<string, unknown>,
  keys: string[] | undefined,
): Record<string, unknown> {
  if (!keys?.length) return params;
  const masked: Record<string, unknown> = { ...params };
  for (const key of keys) {
    if (masked[key] !== undefined) masked[key] = "[redacted]";
  }
  return masked;
}

function capParams(params: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(params);
  } catch {
    return { unserializableParams: true };
  }
  if (json.length <= PARAMS_JSON_CAP) return params;
  return { paramsTruncated: true, fullLength: json.length, preview: json.slice(0, PARAMS_JSON_CAP) };
}
