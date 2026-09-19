#!/usr/bin/env node
// Real end-to-end verification for Git #4822:
//   1. batch_remove_sub_issues — detaches for real, leaves every child untouched,
//      and one deliberately-wrong entry fails independently of the others.
//   2. move_to_status / batch_move_to_status with a non-default `repo` override —
//      the add-to-board path must resolve the issue in THAT repo (the bug was
//      resolveRepo() being applied twice, the second pass dropping the override).
//
// Calls the real ToolDef handlers against the REAL GitHub API with the real
// server-side PAT — no mocks, no fixtures. All disposable test issues live in
// the scratch target repo (default shanemccaw/shanes-git, which is itself a
// non-default repo for this server) so no real Epic/Feature hierarchy in the
// main repo is touched. Every test issue is closed, and its project item
// deleted, by this script's own finally block.
//
// Usage: node scripts/verify-remove-batch-and-cross-repo-move.mjs [owner/repo]

import { loadEnvLocal, githubPat, resolveRepo } from "../src/env.ts";
import { TOOLS_BY_NAME, toolManifest } from "../src/tools/index.ts";
import { githubGraphQL, getIssueSummary, getParentIssue, listSubIssues } from "../src/github.ts";

loadEnvLocal();

const PAT = githubPat();
const TARGET = process.argv[2] ?? "shanemccaw/shanes-git";
const target = resolveRepo(TARGET);
const CTX = { tokenId: null, tokenLabel: "verify-4822", log: () => {} };
const CALL_CONTEXT = "verify-4822";
const RUN_TAG = `#4822-verify-${Date.now()}`;
const NONEXISTENT_ISSUE = 99999999;
// The one shared Projects v2 board move_to_status writes to (same id as move-to-status.ts).
const PROJECT_V2_ID = "PVT_kwHOEiBDdc4BeoiY";

let failures = 0;
const payloads = [];
const createdIssueNumbers = [];

function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
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

async function createTestIssue(title) {
  const created = await call("create_issue", {
    title: `TEST(${RUN_TAG}): ${title} — safe to delete, closed by this script`,
    body: "Disposable verification artifact for Git #4822 (shanes-git batch_remove_sub_issues / cross-repo move_to_status). Closed by the script run that created it.",
    repo: TARGET,
    context: CALL_CONTEXT,
  });
  createdIssueNumbers.push(created.number);
  return created.number;
}

async function snapshot(n) {
  const s = await getIssueSummary(n, target);
  const comments = await call("list_comments", { number: n, repo: TARGET });
  return JSON.stringify({ number: s.number, title: s.title, state: s.state, comments });
}

console.log(`Git #4822 verification against ${target.owner}/${target.repo}`);
if (!PAT) {
  console.log("\nNo server-side PAT configured — cannot verify against real GitHub. Set GITHUB_MCP_PAT.");
  process.exit(1);
}

try {
  check("batch_remove_sub_issues is in the tools/list manifest", toolManifest().some((t) => t.name === "batch_remove_sub_issues"));
  check("resolveRepo passes an already-resolved { owner, repo } through unchanged", JSON.stringify(resolveRepo(target)) === JSON.stringify(target));

  // ---- 1. batch_remove_sub_issues ------------------------------------------
  console.log("\nCreating real disposable test issues...");
  const parent = await createTestIssue("Feature: Batch Remove parent");
  const children = [];
  for (let i = 1; i <= 4; i++) children.push(await createTestIssue(`child ${i}`));
  const unrelated = await createTestIssue("never a child of the parent");
  console.log(`  ..   created ${createdIssueNumbers.length} test issues: ${createdIssueNumbers.join(", ")}`);

  for (const c of children) await call("add_sub_issue", { parent_number: parent, child_number: c, repo: TARGET, context: CALL_CONTEXT });
  check(`parent #${parent} starts with all 4 children attached`, (await listSubIssues(parent, target)).length === 4);

  const before = {};
  for (const c of children) before[c] = await snapshot(c);

  // 3 real removals + 1 removal of an issue that is not a child of the parent
  // (real GitHub error) + 1 nonexistent child, in one call. The last real child
  // stays attached to prove the batch removes only what it was told to.
  const result = await call("batch_remove_sub_issues", {
    removals: [
      { childNumber: children[0], parentNumber: parent },
      { childNumber: unrelated, parentNumber: parent },
      { childNumber: children[1], parentNumber: parent },
      { childNumber: NONEXISTENT_ISSUE, parentNumber: parent },
      { childNumber: children[2], parentNumber: parent },
    ],
    repo: TARGET,
    context: CALL_CONTEXT,
  });
  console.log(`  ..   result: ${JSON.stringify(result.results.map((r) => [r.childNumber, r.success]))}`);
  check("totalAttempted is 5", result.totalAttempted === 5);
  check("succeededCount is 3", result.succeededCount === 3, `got ${result.succeededCount}`);
  check("failedCount is 2", result.failedCount === 2, `got ${result.failedCount}`);
  check("the two wrong entries report success:false with a real error", result.results.filter((r) => !r.success).every((r) => typeof r.error === "string" && r.error.length > 0));
  check("results are reported in request order", result.results.map((r) => r.childNumber).join() === [children[0], unrelated, children[1], NONEXISTENT_ISSUE, children[2]].join());

  const remaining = await listSubIssues(parent, target);
  check(`GitHub: parent #${parent} now has exactly 1 sub-issue, the untouched children[3]`, remaining.length === 1 && remaining[0].number === children[3]);
  for (const c of children.slice(0, 3)) check(`GitHub: #${c} has no parent`, (await getParentIssue(c, target)) === null);
  for (const c of children.slice(0, 3)) check(`GitHub: #${c} state/title/comments untouched`, (await snapshot(c)) === before[c]);

  const emptyBatch = await call("batch_remove_sub_issues", { removals: [], repo: TARGET, context: CALL_CONTEXT }).then(() => null, (e) => e);
  check("empty removals[] is rejected before any GitHub call", emptyBatch instanceof Error);
  const noCtx = await call("batch_remove_sub_issues", { removals: [{ childNumber: 1, parentNumber: 2 }] }).then(() => null, (e) => e);
  check("missing context is rejected before any GitHub call", noCtx instanceof Error);

  // ---- 2. move_to_status with a non-default repo ---------------------------
  console.log("\nCross-repo move_to_status / batch_move_to_status...");
  const single = await call("move_to_status", { number: children[0], status: "Backlog", repo: TARGET, context: CALL_CONTEXT });
  check(`move_to_status #${children[0]} (${TARGET}) succeeds and adds it to the board`, single.status === "Backlog" && single.addedToBoard === true, JSON.stringify(single));

  const batch = await call("batch_move_to_status", {
    moves: [
      { number: children[1], status: "Backlog" },
      { number: NONEXISTENT_ISSUE, status: "Backlog" },
    ],
    repo: TARGET,
    context: CALL_CONTEXT,
  });
  check("batch_move_to_status with repo override: real item succeeds, nonexistent fails independently", batch.succeededCount === 1 && batch.failedCount === 1, JSON.stringify(batch));

  const board = await call("get_board_status", { number: children[0], repo: TARGET });
  check("get_board_status agrees the moved issue sits in Backlog", JSON.stringify(board).includes("Backlog"), JSON.stringify(board));

  // Remove the disposable board items so nothing test-shaped lingers on the shared board.
  for (const n of [children[0], children[1]]) {
    const q = await githubGraphQL(
      `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:20){nodes{id project{id}}}}}}`,
      { o: target.owner, r: target.repo, n },
    );
    for (const item of q.repository.issue.projectItems.nodes.filter((x) => x.project.id === PROJECT_V2_ID)) {
      await githubGraphQL(`mutation($p:ID!,$i:ID!){deleteProjectV2Item(input:{projectId:$p,itemId:$i}){deletedItemId}}`, { p: PROJECT_V2_ID, i: item.id });
    }
  }

  check("the GitHub PAT never appears in any result", !payloads.join("\n").includes(PAT));
} finally {
  if (createdIssueNumbers.length > 0) {
    console.log(`\nCleanup: closing ${createdIssueNumbers.length} disposable test issue(s)...`);
    try {
      const r = await call("batch_close_issues", {
        closures: createdIssueNumbers.map((number) => ({
          number,
          stateReason: "not_planned",
          comment: "Disposable Git #4822 verification issue — closing as part of the same script run.",
        })),
        repo: TARGET,
        context: CALL_CONTEXT,
      });
      check("every disposable test issue closed", r.failedCount === 0, JSON.stringify(r));
    } catch (err) {
      console.log(`  FAIL cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  Close manually in ${TARGET}: ${createdIssueNumbers.join(", ")}`);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
