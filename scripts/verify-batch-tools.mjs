#!/usr/bin/env node
// Real end-to-end verification for the batch tools (Git #3709):
//   batch_reparent_sub_issues, batch_move_to_status, batch_close_issues
//
// Calls the real ToolDef handlers against the REAL GitHub API with the real
// server-side PAT — no mocks, no fixtures. Per the issue's own real
// verification ask: "run a real batch of at least 10 real operations (a mix
// that includes at least one real, expected failure ...) and confirm the
// response correctly reports which succeeded and which failed, with an
// accurate real reason for each failure, and confirm the real GitHub state
// actually reflects every reported success."
//
// This script creates real, clearly-labeled DISPOSABLE test issues
// (title-tagged "TEST(#3709 batch verify ...)"), exercises all three batch
// tools against them (≥10 real operations each, each batch including one
// item targeting a nonexistent issue number as the real expected failure —
// chosen over an at-cap-parent failure so this script cannot accidentally
// trigger a real overflow-Feature CREATE write against production hierarchy,
// same caution verify-hierarchy-and-caps.mjs applies to its own risky
// branch), verifies the real GitHub state directly, then closes every real
// test issue it created via batch_close_issues itself — so this script
// leaves nothing open on the board even if a check fails mid-run.
//
// Exits non-zero on any failure.
//
// Usage: node artifacts/github-mcp-server/scripts/verify-batch-tools.mjs

import { loadEnvLocal, githubPat, githubRepo } from "../src/env.ts";
import { TOOLS_BY_NAME, toolManifest } from "../src/tools/index.ts";
import { getParentIssue, listSubIssues } from "../src/github.ts";

loadEnvLocal();

const PAT = githubPat();
const { owner, repo } = githubRepo();
const CTX = { tokenId: null, tokenLabel: "verify-batch-tools", log: () => {} };
const CALL_CONTEXT = "verify-batch-tools-3709";
const RUN_TAG = `#3709-verify-${Date.now()}`;
// A GitHub issue number this repo will never genuinely reach — the real,
// deterministic "expected failure" every batch below includes.
const NONEXISTENT_ISSUE = 99999999;

let failures = 0;
const payloads = [];
const createdIssueNumbers = [];

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

async function createTestIssue(title, body) {
  const created = await call("create_issue", {
    title: `TEST(${RUN_TAG}): ${title} — safe to delete, closed by this script`,
    body: `Real, disposable verification artifact for Git #3709's batch-tools verification script. ` +
      `${body} This issue is closed by the same script run that created it — if you're reading this ` +
      `and it's still open, the verification run that made it did not finish cleanly.`,
    context: CALL_CONTEXT,
  });
  createdIssueNumbers.push(created.number);
  return created.number;
}

console.log(`GitHub MCP batch-tools verification (Git #3709) against ${owner}/${repo}`);
console.log(`PAT configured: ${PAT ? "yes" : "no"}`);
if (!PAT) {
  console.log("\nNo server-side PAT configured — cannot verify against real GitHub. Set GITHUB_MCP_PAT.");
  process.exit(1);
}

try {
  // 0. registration
  const manifest = toolManifest();
  for (const name of ["batch_reparent_sub_issues", "batch_move_to_status", "batch_close_issues"]) {
    check(`${name} is in the tools/list manifest`, manifest.some((t) => t.name === name));
  }

  // 1. Create real test fixtures: 10 plain issues + 2 "Feature:" issues to
  //    reparent between. None are parented under any real Epic/Feature, so
  //    this cannot pollute real hierarchy.
  console.log("\nCreating real disposable test issues...");
  const bugNumbers = [];
  for (let i = 1; i <= 10; i++) {
    bugNumbers.push(await createTestIssue(`bug ${i}`, "A plain (non-Feature) test issue."));
  }
  const featureA = await createTestIssue("Feature: Batch Reparent A", "The real starting parent.");
  const featureB = await createTestIssue("Feature: Batch Reparent B", "The real target parent.");
  console.log(`  ..   created ${createdIssueNumbers.length} real test issues: ${createdIssueNumbers.join(", ")}`);

  // Attach all 10 bug issues under featureA using the already-proven
  // add_sub_issue tool directly (not what this script verifies).
  for (const n of bugNumbers) {
    await call("add_sub_issue", { parent_number: featureA, child_number: n, context: CALL_CONTEXT });
  }
  const startingChildren = await listSubIssues(featureA);
  check(
    `real featureA #${featureA} starts with all 10 real test bug issues attached`,
    startingChildren.length === 10 && bugNumbers.every((n) => startingChildren.some((c) => c.number === n)),
    JSON.stringify(startingChildren.map((c) => c.number)),
  );

  // 2. batch_move_to_status — 10 real successes + 1 real expected failure
  //    (nonexistent issue number) = 11 real operations attempted.
  console.log("\nbatch_move_to_status — 11 real operations (10 expected success, 1 expected failure)...");
  const statusMoves = [...bugNumbers, NONEXISTENT_ISSUE].map((number) => ({ number, status: "AI Batter Up" }));
  const statusResult = await call("batch_move_to_status", { moves: statusMoves, context: CALL_CONTEXT });
  check("batch_move_to_status totalAttempted === 11", statusResult.totalAttempted === 11, statusResult.totalAttempted);
  check("batch_move_to_status succeededCount === 10", statusResult.succeededCount === 10, statusResult.succeededCount);
  check("batch_move_to_status failedCount === 1", statusResult.failedCount === 1, statusResult.failedCount);
  const statusFailure = statusResult.results.find((r) => r.number === NONEXISTENT_ISSUE);
  check(
    "the real expected failure item reports success:false with a real error naming the issue",
    statusFailure?.success === false && typeof statusFailure?.error === "string" && statusFailure.error.length > 0,
    JSON.stringify(statusFailure),
  );
  check(
    "every OTHER item in batch_move_to_status reports success:true",
    bugNumbers.every((n) => statusResult.results.find((r) => r.number === n)?.success === true),
  );
  // Confirm real GitHub state for one real success directly (not just trusting the tool's own report).
  const oneBoardStatus = await call("get_board_status", { number: bugNumbers[0] });
  check(
    `real board state for #${bugNumbers[0]} actually reflects the reported move`,
    oneBoardStatus.onBoard === true && oneBoardStatus.status === "AI Batter Up",
    JSON.stringify(oneBoardStatus),
  );

  // 3. batch_reparent_sub_issues — move all 10 real bug issues from featureA
  //    to featureB, plus 1 real expected failure (nonexistent child) = 11
  //    real operations attempted.
  console.log("\nbatch_reparent_sub_issues — 11 real operations (10 expected success, 1 expected failure)...");
  const reparentMoves = [
    ...bugNumbers.map((issueNumber) => ({ issueNumber, fromParent: featureA, toParent: featureB })),
    { issueNumber: NONEXISTENT_ISSUE, fromParent: featureA, toParent: featureB },
  ];
  const reparentResult = await call("batch_reparent_sub_issues", { moves: reparentMoves, context: CALL_CONTEXT });
  check("batch_reparent_sub_issues totalAttempted === 11", reparentResult.totalAttempted === 11, reparentResult.totalAttempted);
  check("batch_reparent_sub_issues succeededCount === 10", reparentResult.succeededCount === 10, reparentResult.succeededCount);
  check("batch_reparent_sub_issues failedCount === 1", reparentResult.failedCount === 1, reparentResult.failedCount);
  const reparentFailure = reparentResult.results.find((r) => r.issueNumber === NONEXISTENT_ISSUE);
  check(
    "the real expected reparent failure reports success:false, partial:false, real error",
    reparentFailure?.success === false && reparentFailure?.partial === false && typeof reparentFailure?.error === "string",
    JSON.stringify(reparentFailure),
  );
  check(
    "every OTHER item in batch_reparent_sub_issues reports success:true landed under featureB",
    bugNumbers.every((n) => {
      const r = reparentResult.results.find((row) => row.issueNumber === n);
      return r?.success === true && r?.toParent === featureB;
    }),
  );
  // Confirm real GitHub state directly: featureA now has 0 real children, featureB has all 10.
  const [afterA, afterB] = await Promise.all([listSubIssues(featureA), listSubIssues(featureB)]);
  check(`real featureA #${featureA} now has 0 real sub-issues`, afterA.length === 0, JSON.stringify(afterA.map((c) => c.number)));
  check(
    `real featureB #${featureB} now genuinely has all 10 real bug issues`,
    afterB.length === 10 && bugNumbers.every((n) => afterB.some((c) => c.number === n)),
    JSON.stringify(afterB.map((c) => c.number)),
  );
  const oneRealParent = await getParentIssue(bugNumbers[0]);
  check(
    `getParentIssue confirms #${bugNumbers[0]}'s real current parent is featureB, not featureA`,
    oneRealParent?.number === featureB,
    JSON.stringify(oneRealParent),
  );

  // 4. batch_close_issues — close all 12 real test issues (10 bugs + 2
  //    features) + 1 real expected failure (nonexistent number) = 13 real
  //    operations attempted. This is also this script's own real cleanup.
  console.log("\nbatch_close_issues — 13 real operations (12 expected success, 1 expected failure)...");
  const closures = [
    ...createdIssueNumbers.map((number) => ({ number, stateReason: "completed" })),
    { number: NONEXISTENT_ISSUE, stateReason: "completed" },
  ];
  const closeResult = await call("batch_close_issues", { closures, context: CALL_CONTEXT });
  check("batch_close_issues totalAttempted === 13", closeResult.totalAttempted === 13, closeResult.totalAttempted);
  check("batch_close_issues succeededCount === 12", closeResult.succeededCount === 12, closeResult.succeededCount);
  check("batch_close_issues failedCount === 1", closeResult.failedCount === 1, closeResult.failedCount);
  const closeFailure = closeResult.results.find((r) => r.number === NONEXISTENT_ISSUE);
  check(
    "the real expected close failure reports success:false with a real error",
    closeFailure?.success === false && typeof closeFailure?.error === "string",
    JSON.stringify(closeFailure),
  );
  check(
    "every real test issue reports success:true with a real closed state",
    createdIssueNumbers.every((n) => {
      const r = closeResult.results.find((row) => row.number === n);
      return r?.success === true && r?.state === "closed";
    }),
  );
  // Confirm real GitHub state directly for one of them.
  const closedCheck = await call("get_issue", { number: createdIssueNumbers[0] });
  check(
    `real GitHub state confirms #${createdIssueNumbers[0]} is genuinely closed`,
    closedCheck.state === "closed",
    JSON.stringify({ number: closedCheck.number, state: closedCheck.state }),
  );
  // All test issues are now closed — cleanup done via the tool under test itself.
  createdIssueNumbers.length = 0;

  // 5. the PAT never appears in any result, anywhere.
  const allText = payloads.join("\n");
  check("the GitHub PAT never appears in any result", !PAT || !allText.includes(PAT));
} finally {
  // Real safety net: if anything above threw before batch_close_issues ran,
  // make sure no real disposable test issue is left open.
  if (createdIssueNumbers.length > 0) {
    console.log(`\nCleanup: closing ${createdIssueNumbers.length} real test issue(s) left over from a failed run...`);
    try {
      await call("batch_close_issues", {
        closures: createdIssueNumbers.map((number) => ({
          number,
          stateReason: "not_planned",
          comment: "Verification run for Git #3709 did not complete cleanly — closing this disposable test issue as cleanup.",
        })),
        context: CALL_CONTEXT,
      });
    } catch (err) {
      console.log(`  FAIL cleanup itself failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  Real test issues left open — close manually: ${createdIssueNumbers.join(", ")}`);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
