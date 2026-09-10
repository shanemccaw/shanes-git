#!/usr/bin/env node
// Revoke an MCP bearer token by id. The row is kept (not deleted) so the activity trail stays
// intact; a revoked token resolves as invalid immediately.
//
//   npm run revoke-token -- --id 3

import { loadEnvLocal } from "../src/env.ts";
import { revokeToken } from "../src/tokens.ts";
import { closePool } from "../src/db.ts";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

try {
  loadEnvLocal();
  const idRaw = arg("id");
  const id = idRaw ? Number.parseInt(idRaw, 10) : NaN;
  if (!Number.isInteger(id)) {
    console.error("Usage: npm run revoke-token -- --id <tokenId>");
    process.exitCode = 1;
  } else {
    const revoked = await revokeToken(id);
    console.log(revoked ? `Token #${id} revoked.` : `No live token #${id} found (already revoked or nonexistent).`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
