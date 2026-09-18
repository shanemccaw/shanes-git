#!/usr/bin/env node
// Real end-to-end verification for #4697 (Feature #4692):
//   - `Done` removed from move_to_status / list_board_column enums
//   - add_label / remove_label true-delta label tools
//   - close_issue's unconditional terminal-state-label strip
//
// Calls the real ToolDef handlers against the REAL GitHub API with the real
// server-side PAT — no mocks, no fixtures. Creates one real, clearly-labeled
// DISPOSABLE test issue, exercises the real tools against it, verifies the real
// GitHub state directly (not just the tools' own reports), and closes the test
// issue (the close IS the strip test, and also this script's own cleanup) so it
// leaves nothing open even if a check fails mid-run.
//
// Exits non-zero on any failure.
//
// Usage: node scripts/verify-labels-and-status.mjs   (needs GIT_PAT/GITHUB_MCP_PAT)

import { loadEnvLocal, githubPat, githubRepo } from "../src/env.ts";
import { TOOLS_BY_NAME, toolManifest } from "../src/tools/index.ts";
import { getIssueLabels } from "../src/github.ts";
import { ALLOWED_STATUSES } from "../src/tools/move-to-status.ts";

loadEnvLocal();

const PAT = githubPat();
const { owner, repo } = githubRepo();
const CTX = { tokenId: null, tokenLabel: "verify-labels-and-status", log: () => {} };
const CALL_CONTEXT = "verify-labels-and-status-4697";
const RUN_TAG = `#4697-verify-${Date.now()}`;

let failures = 0;
const payloads = [];
let testIssue = null;

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

console.log(`GitHub MCP labels+status verification (#4697) against ${owner}/${repo}`);
console.log(`PAT configured: ${PAT ? "yes" : "no"}`);
if (!PAT) {
  console.log("\nNo server-side PAT configured — cannot verify against real GitHub. Set GITHUB_MCP_PAT/GIT_PAT.");
  process.exit(1);
}

try {
  // 0. Registration + enum shape (no GitHub calls).
  const manifest = toolManifest();
  const moveDef = manifest.find((t) => t.name === "move_to_status");
  const listColDef = manifest.find((t) => t.name === "list_board_column");
  check("add_label is in the tools/list manifest", manifest.some((t) => t.name === "add_label"));
  check("remove_label is in the tools/list manifest", manifest.some((t) => t.name === "remove_label"));
  check(
    'move_to_status enum no longer contains "Done"',
    Array.isArray(moveDef?.inputSchema?.properties?.status?.enum) &&
      !moveDef.inputSchema.properties.status.enum.includes("Done"),
    JSON.stringify(moveDef?.inputSchema?.properties?.status?.enum),
  );
  check(
    'move_to_status enum is exactly the 4 human-gate columns',
    JSON.stringify(moveDef?.inputSchema?.properties?.status?.enum) ===
      JSON.stringify(["Batter Up", "Backlog", "AI Batter Up", "Ask Shane"]),
    JSON.stringify(moveDef?.inputSchema?.properties?.status?.enum),
  );
  check(
    'ALLOWED_STATUSES export no longer contains "Done"',
    !ALLOWED_STATUSES.includes("Done"),
    JSON.stringify(ALLOWED_STATUSES),
  );
  check(
    'list_board_column enum no longer contains "Done"',
    Array.isArray(listColDef?.inputSchema?.properties?.status?.enum) &&
      !listColDef.inputSchema.properties.status.enum.includes("Done"),
    JSON.stringify(listColDef?.inputSchema?.properties?.status?.enum),
  );

  // 1. move_to_status("Done") is rejected with a clear error naming the real
  //    allowed list (NOT a silent no-op) — and no GitHub call is made (the
  //    validation throws before any request). Use a real issue number shape so
  //    only the status can be what's rejected.
  console.log('\nmove_to_status("Done") must be rejected cleanly...');
  let rejected = null;
  try {
    await call("move_to_status", { number: 1, status: "Done", context: CALL_CONTEXT });
  } catch (err) {
    rejected = err instanceof Error ? err.message : String(err);
  }
  check(
    'move_to_status("Done") threw a clear "must be one of" rejection',
    typeof rejected === "string" && rejected.includes("must be one of"),
    JSON.stringify(rejected),
  );
  check(
    'the rejection\'s allowed-list does NOT include "Done"',
    typeof rejected === "string" && !rejected.split("got:")[0].includes("Done"),
    JSON.stringify(rejected),
  );

  // 2. Create one real disposable test issue.
  console.log("\nCreating one real disposable test issue...");
  const created = await call("create_issue", {
    title: `TEST(${RUN_TAG}): label + close-strip verification — safe to delete, closed by this script`,
    body:
      "Real, disposable verification artifact for #4697's label/close-strip verification script. " +
      "This issue is closed by the same script run that created it — if you're reading this and " +
      "it's still open, the verification run that made it did not finish cleanly.",
    context: CALL_CONTEXT,
  });
  testIssue = created.number;
  console.log(`  ..   created real test issue #${testIssue}`);

  // 3. add_label — true additive delta, idempotent no-op on re-add.
  console.log("\nadd_label — real additive delta...");
  const add1 = await call("add_label", { number: testIssue, label: "blocked", context: CALL_CONTEXT });
  check("add_label blocked reports changed:true", add1.changed === true, JSON.stringify(add1));
  check("add_label blocked result labels include blocked", add1.labels.includes("blocked"), JSON.stringify(add1.labels));
  const addAgain = await call("add_label", { number: testIssue, label: "blocked", context: CALL_CONTEXT });
  check("add_label blocked again is an idempotent no-op (changed:false)", addAgain.changed === false, JSON.stringify(addAgain));

  // Add two NON-state labels that must survive the close strip, plus the other
  // two terminal-state labels so the strip is exercised on more than `blocked`.
  await call("add_label", { number: testIssue, label: "Shane To-Do", context: CALL_CONTEXT });
  await call("add_label", { number: testIssue, label: "bug", context: CALL_CONTEXT });
  await call("add_label", { number: testIssue, label: "in-flight", context: CALL_CONTEXT });
  const afterAdds = await getIssueLabels(testIssue);
  check(
    "real GitHub state shows all four labels present before removal test",
    ["blocked", "Shane To-Do", "bug", "in-flight"].every((l) => afterAdds.includes(l)),
    JSON.stringify(afterAdds),
  );

  // 4. remove_label — true subtractive delta, touches only the named label.
  console.log("\nremove_label — real subtractive delta that touches only the named label...");
  const rem1 = await call("remove_label", { number: testIssue, label: "in-flight", context: CALL_CONTEXT });
  check("remove_label in-flight reports changed:true", rem1.changed === true, JSON.stringify(rem1));
  check("remove_label in-flight result no longer includes in-flight", !rem1.labels.includes("in-flight"), JSON.stringify(rem1.labels));
  check(
    "remove_label left every OTHER label untouched (blocked, Shane To-Do, bug)",
    ["blocked", "Shane To-Do", "bug"].every((l) => rem1.labels.includes(l)),
    JSON.stringify(rem1.labels),
  );
  const remAgain = await call("remove_label", { number: testIssue, label: "in-flight", context: CALL_CONTEXT });
  check("remove_label in-flight again is an idempotent no-op (changed:false)", remAgain.changed === false, JSON.stringify(remAgain));

  // 5. THE core close-strip test: issue now carries `blocked` + `Shane To-Do`
  //    + `bug`. close_issue(completed) must strip `blocked` (a terminal-state
  //    label) and leave `Shane To-Do` and `bug` untouched.
  console.log("\nclose_issue must strip terminal-state labels and leave the rest...");
  const closeResult = await call("close_issue", {
    number: testIssue,
    state_reason: "completed",
    context: CALL_CONTEXT,
  });
  check("close_issue reports state closed", closeResult.state === "closed", JSON.stringify(closeResult));
  check(
    "close_issue strippedLabels === ['blocked'] (only the present terminal-state label)",
    JSON.stringify(closeResult.strippedLabels) === JSON.stringify(["blocked"]),
    JSON.stringify(closeResult.strippedLabels),
  );
  // Confirm the REAL GitHub label state directly, not just the tool's report.
  const afterClose = await getIssueLabels(testIssue);
  check("real GitHub state: `blocked` is genuinely gone after close", !afterClose.includes("blocked"), JSON.stringify(afterClose));
  check(
    "real GitHub state: `Shane To-Do` and `bug` genuinely SURVIVE the close",
    afterClose.includes("Shane To-Do") && afterClose.includes("bug"),
    JSON.stringify(afterClose),
  );
  const closedIssue = await call("get_issue", { number: testIssue });
  check(`real GitHub state confirms #${testIssue} is genuinely closed`, closedIssue.state === "closed", JSON.stringify({ number: closedIssue.number, state: closedIssue.state }));
  testIssue = null; // closed — cleanup already done by the tool under test.

  // 6. The PAT never appears in any result, anywhere.
  const allText = payloads.join("\n");
  check("the GitHub PAT never appears in any result", !PAT || !allText.includes(PAT));
} finally {
  // Real safety net: if anything above threw before the close, don't leave the
  // disposable test issue open.
  if (testIssue !== null) {
    console.log(`\nCleanup: closing real test issue #${testIssue} left over from a failed run...`);
    try {
      await call("close_issue", {
        number: testIssue,
        state_reason: "not_planned",
        comment: "Verification run for #4697 did not complete cleanly — closing this disposable test issue as cleanup.",
        context: CALL_CONTEXT,
      });
    } catch (err) {
      console.log(`  FAIL cleanup itself failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  Real test issue left open — close manually: #${testIssue}`);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
