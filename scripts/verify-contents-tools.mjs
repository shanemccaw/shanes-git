#!/usr/bin/env node
// Real end-to-end verification for the repository-contents tools (Git #3697):
//   get_file_contents, list_directory, search_code
//
// Calls the real ToolDef handlers against the REAL GitHub API with the real
// server-side PAT — no mocks, no fixtures. Unlike scripts/smoke-check.mjs this
// needs no database: it exercises the handlers directly, which is the same code
// path protocol.ts invokes (registry.runTool only wraps them with activity
// recording). Verifies:
//   1. all three tools are registered and appear in the tools/list manifest
//   2. get_file_contents returns a real file's REAL decoded text
//   3. get_file_contents at an explicit `ref` reads that ref
//   4. get_file_contents refuses a directory with a useful message
//   5. get_file_contents rejects a ".." path before any GitHub call
//   6. a missing path produces an honest, path-naming error (not a bare 404)
//   7. list_directory lists the repo root and a real subdirectory
//   8. list_directory refuses a file with a useful message
//   9. search_code finds a real, known string and returns real match fragments
//  10. the GitHub PAT NEVER appears in any result, anywhere
//
// Exits non-zero on any failure.
//
// Usage: node artifacts/github-mcp-server/scripts/verify-contents-tools.mjs

import { loadEnvLocal, githubPat, githubRepo } from "../src/env.ts";
import { TOOLS_BY_NAME, toolManifest } from "../src/tools/index.ts";

loadEnvLocal();

const PAT = githubPat();
const { owner, repo } = githubRepo();
const CTX = { tokenId: null, tokenLabel: "verify-contents-tools", log: () => {} };

let failures = 0;
const payloads = [];

function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function call(tool, args) {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) throw new Error(`tool ${tool} is not registered`);
  const result = await def.handler(args, CTX);
  payloads.push(JSON.stringify(result));
  return result;
}

async function expectError(name, tool, args, matcher) {
  try {
    const result = await call(tool, args);
    check(name, false, `expected a throw, got ${JSON.stringify(result).slice(0, 120)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    payloads.push(message);
    check(name, matcher(message), `message was: ${message}`);
  }
}

console.log(`GitHub MCP contents-tools verification against ${owner}/${repo}`);
console.log(`PAT configured: ${PAT ? "yes" : "no"}`);
if (!PAT) {
  console.log("\nNo server-side PAT configured — cannot verify against real GitHub. Set GITHUB_MCP_PAT.");
  process.exit(1);
}

// 1. registration
const manifest = toolManifest();
for (const name of ["get_file_contents", "list_directory", "search_code"]) {
  check(`${name} is in the tools/list manifest`, manifest.some((t) => t.name === name));
}

// 2. a real file's real content — this file's own package.json, whose real
//    contents we can independently assert on.
const pkg = await call("get_file_contents", { path: "artifacts/github-mcp-server/package.json" });
check("get_file_contents returns decoded text", typeof pkg.content === "string" && pkg.content.length > 0);
check("get_file_contents content is the REAL file", pkg.content?.includes('"@workspace/github-mcp-server"'));
check("get_file_contents content parses as the real JSON it is", (() => {
  try {
    return JSON.parse(pkg.content).name === "@workspace/github-mcp-server";
  } catch {
    return false;
  }
})());
check("get_file_contents reports truncated:false for a small file", pkg.truncated === false);
check("get_file_contents reports binary:false for a text file", pkg.binary === false);
check("get_file_contents reports a real byte size", typeof pkg.size === "number" && pkg.size > 0);
check("get_file_contents returns a real sha", typeof pkg.sha === "string" && pkg.sha.length === 40);
check("get_file_contents leading './' is tolerated", (await call("get_file_contents", {
  path: "./artifacts/github-mcp-server/package.json",
})).sha === pkg.sha);

// 3. explicit ref
const atRef = await call("get_file_contents", {
  path: "artifacts/github-mcp-server/package.json",
  ref: "main",
});
check("get_file_contents honours an explicit ref", atRef.ref === "main" && typeof atRef.content === "string");

// 4/5/6. honest refusals
await expectError(
  "get_file_contents on a directory says so",
  "get_file_contents",
  { path: "artifacts/github-mcp-server/src" },
  (m) => m.includes("is a directory") && m.includes("list_directory"),
);
await expectError(
  'get_file_contents rejects ".." paths',
  "get_file_contents",
  { path: "artifacts/../../etc/passwd" },
  (m) => m.includes('".."'),
);
await expectError(
  "a missing path names the real path and repo",
  "get_file_contents",
  { path: "artifacts/github-mcp-server/definitely-not-a-real-file.ts" },
  (m) => m.includes("definitely-not-a-real-file.ts") && m.includes(`${owner}/${repo}`),
);
await expectError(
  "get_file_contents requires a non-empty path",
  "get_file_contents",
  { path: "   " },
  (m) => m.includes("non-empty `path`"),
);

// 7. directory listings
const root = await call("list_directory", {});
check("list_directory lists the repo root with no path", Array.isArray(root.entries) && root.entries.length > 0);
check("repo root contains the real CLAUDE.md", root.entries.some((e) => e.name === "CLAUDE.md" && e.type === "file"));
check("repo root contains the real artifacts/ dir", root.entries.some((e) => e.name === "artifacts" && e.type === "dir"));
check("list_directory reports truncated:false for the root", root.truncated === false);

const toolsDir = await call("list_directory", { path: "artifacts/github-mcp-server/src/tools" });
check(
  "list_directory lists the real tools dir including this build's new files",
  ["get-file-contents.ts", "list-directory.ts", "search-code.ts"].every((n) =>
    toolsDir.entries.some((e) => e.name === n && e.type === "file"),
  ),
  `entries: ${toolsDir.entries.map((e) => e.name).join(", ")}`,
);
check("list_directory entries carry real paths", toolsDir.entries.every((e) => e.path.startsWith("artifacts/github-mcp-server/src/tools/")));

// 8. honest refusal on a file
await expectError(
  "list_directory on a file says so",
  "list_directory",
  { path: "CLAUDE.md" },
  (m) => m.includes("is a file") && m.includes("get_file_contents"),
);

// 9. code search — either backend is a real pass; which one answered is reported.
const found = await call("search_code", { query: "path:artifacts/github-mcp-server/src/tools search-code", perPage: 20 });
console.log(`  ..   search_code answered from: ${found.source}`);
check("search_code returns real results", found.totalCount > 0 && found.items.length > 0, JSON.stringify(found).slice(0, 300));
check(
  "search_code finds the real file",
  found.items.some((i) => i.path === "artifacts/github-mcp-server/src/tools/search-code.ts"),
  `paths: ${found.items.map((i) => i.path).join(", ")}`,
);
check("search_code scopes the query to the repo", found.query.startsWith(`repo:${owner}/${repo} `));
check(
  "search_code names its backend honestly",
  found.source === "code-search" || found.source === "repo-tree-paths",
  `source: ${found.source}`,
);
if (found.source === "code-search") {
  check("code-search hits carry real matching fragments", found.items.some((i) => i.matches.length > 0));
} else {
  check(
    "path fallback warns that it matched paths, not contents",
    found.note.includes("FILE PATHS, not file contents"),
    found.note,
  );
}

// Path-search qualifiers the fallback genuinely supports.
const byExt = await call("search_code", { query: "extension:sql path:lib/db/migrations/manual", perPage: 100 });
check("search_code extension: + path: qualifiers work", byExt.totalCount > 0 && byExt.items.every((i) => i.path.endsWith(".sql")), `${byExt.totalCount} hits from ${byExt.source}`);
const byFilename = await call("search_code", { query: "filename:CLAUDE.md", perPage: 5 });
check("search_code filename: qualifier works", byFilename.items.some((i) => i.path === "CLAUDE.md"), `paths: ${byFilename.items.map((i) => i.path).join(", ")}`);
const noisy = await call("search_code", { query: "language:ts", perPage: 5 });
check(
  "a query of only unevaluable qualifiers returns nothing, not everything",
  noisy.source === "code-search" || (noisy.totalCount === 0 && noisy.ignoredQualifiers.includes("language:ts")),
  `${noisy.source} totalCount=${noisy.totalCount} ignored=${JSON.stringify(noisy.ignoredQualifiers)}`,
);
await expectError(
  "search_code requires a non-empty query",
  "search_code",
  { query: "" },
  (m) => m.includes("non-empty `query`"),
);

// 10. the PAT must never appear in any payload these tools produced
check(
  "PAT never appears in any result or error message",
  !payloads.some((p) => p.includes(PAT)),
);

console.log(failures === 0 ? "\nAll contents-tool checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
