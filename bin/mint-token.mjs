#!/usr/bin/env node
// Mint a bearer token for a Claude connection to the GitHub MCP server.
//
// This is the "real settings/admin surface" first-mint path (Feature #3377): the token is shown
// ONCE here and never again — only its SHA-256 is stored. A BuildConsole Settings UI can call the
// same issueToken() later; this CLI is what mints the first one before any UI exists.
//
//   npm run mint-token -- --label "Claude Desktop"

import { loadEnvLocal, serverHost, serverPort } from "../src/env.ts";
import { issueToken } from "../src/tokens.ts";
import { closePool } from "../src/db.ts";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

try {
  loadEnvLocal();
  const label = arg("label") || "cli";
  const issued = await issueToken(label);
  const endpoint = `http://${serverHost()}:${serverPort()}/mcp`;
  console.log("");
  console.log(`Token minted, labelled "${issued.label}" (id ${issued.id}).`);
  console.log("It is shown once. It cannot be recovered — mint another if it is lost.");
  console.log("");
  console.log(`  token:    ${issued.token}`);
  console.log(`  endpoint: ${endpoint}`);
  console.log(`  url form: http://${serverHost()}:${serverPort()}/mcp/t/${issued.token}`);
  console.log("");
  console.log("Claude Code:");
  console.log(`  claude mcp add --transport http github-mcp ${endpoint} \\`);
  console.log(`    --header "Authorization: Bearer ${issued.token}"`);
  console.log("");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
