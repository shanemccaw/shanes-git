#!/usr/bin/env node
// List the minted MCP bearer tokens (never their secrets — those are unrecoverable by design).
//
//   npm run list-tokens

import { loadEnvLocal } from "../src/env.ts";
import { listTokens } from "../src/tokens.ts";
import { closePool } from "../src/db.ts";

try {
  loadEnvLocal();
  const tokens = await listTokens();
  if (tokens.length === 0) {
    console.log("No MCP tokens minted yet. Mint one: npm run mint-token -- --label \"...\"");
  } else {
    for (const t of tokens) {
      const state = t.revokedAt ? `REVOKED ${t.revokedAt.toISOString()}` : "active";
      const last = t.lastUsedAt ? t.lastUsedAt.toISOString() : "never";
      console.log(
        `#${t.id}  ${t.label}  [${state}]  calls=${t.callCount}  last=${last}  created=${t.createdAt.toISOString()}`,
      );
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
