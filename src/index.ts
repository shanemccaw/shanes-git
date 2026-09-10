import { loadEnvLocal, githubPat } from "./env.ts";
import { logger } from "./logger.ts";
import { query, closePool } from "./db.ts";
import { startServer } from "./server.ts";

/**
 * Boot order, deliberately: load env, confirm the DB (and the token tables) are
 * reachable, then listen. The GitHub PAT is checked only for a startup log line
 * — the server intentionally still comes up WITHOUT one, so the auth/scaffold
 * half works and server_status can report "patConfigured: false" honestly
 * rather than crashing the process.
 */
async function main(): Promise<void> {
  loadEnvLocal();

  // Fail fast if the token store is not reachable — a server that cannot check a
  // bearer token against github_mcp_tokens must not accept connections.
  await query("SELECT 1 FROM github_mcp_tokens LIMIT 1");
  logger.info("database reachable, token store present");

  if (!githubPat()) {
    logger.warn(
      "no GitHub PAT configured (GITHUB_MCP_PAT / GIT_PAT) — the server will run and authenticate " +
        "bearer tokens, but any tool that calls GitHub will report the PAT as not configured",
    );
  }

  const server = startServer();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    closePool()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal(
    { err: err instanceof Error ? (err.stack ?? err.message) : String(err) },
    "MCP server failed to start",
  );
  process.exit(1);
});
