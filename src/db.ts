import pg from "pg";
import { requiredEnv } from "./env.ts";

/**
 * One shared pool against the same local Postgres the api-server reads
 * (DATABASE_URL). Holds the bearer-token store (github_mcp_tokens) and the
 * Recent-Activity trail (github_mcp_activity) — never the GitHub PAT, which
 * lives only in the process environment.
 */
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: requiredEnv("DATABASE_URL"),
      max: 4,
      allowExitOnIdle: true,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
