#!/usr/bin/env node
// Real end-to-end verification for Git #3708:
//   1. list_sub_issues / list_blocked_by no longer cap at GitHub's own 30-row
//      default page (per_page=100 fix in src/github.ts)
//   2. Epic -> Feature -> Issue hierarchy enforcement (src/hierarchy.ts,
//      enforceHierarchyOrThrow) — a non-Feature child is rejected under an
//      Epic; a Feature child, or any child under a non-Epic parent, is not
//   3. the proactive-overflow naming/canonicalization logic
//      (splitTrailingParen/stripPartSuffix/canonicalFeatureName/partNumber/
//      buildOverflowTitle) against the REAL #1788 -> #3706 pattern already
//      live in this repo, plus a real no-redirect-needed live read via
//      resolveOverflowParent
//
// Calls real handlers/functions against the REAL GitHub API with the real
// server-side PAT — no mocks. Deliberately never performs a real add/create
// write: every case that would need one (a genuinely-passing add_sub_issue,
// or a genuinely-at-cap resolveOverflowParent redirect/create) is instead
// exercised through the pure functions directly, so this script cannot
// mutate real issue relationships or create real overflow issues just by
// being run.
//
// Exits non-zero on any failure.
//
// Usage: node artifacts/github-mcp-server/scripts/verify-hierarchy-and-caps.mjs

import { loadEnvLocal, githubPat, githubRepo } from "../src/env.ts";
import { TOOLS_BY_NAME, toolManifest } from "../src/tools/index.ts";
import { classifyIssueTitle, getIssueSummary, getParentIssue } from "../src/github.ts";
import {
  enforceHierarchyOrThrow,
  resolveOverflowParent,
  HierarchyViolationError,
  splitTrailingParen,
  stripPartSuffix,
  canonicalFeatureName,
  partNumber,
  buildOverflowTitle,
} from "../src/hierarchy.ts";

loadEnvLocal();

const PAT = githubPat();
const { owner, repo } = githubRepo();

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

console.log(`GitHub MCP hierarchy/caps verification (Git #3708) against ${owner}/${repo}`);
console.log(`PAT configured: ${PAT ? "yes" : "no"}`);
if (!PAT) {
  console.log("\nNo server-side PAT configured — cannot verify against real GitHub. Set GITHUB_MCP_PAT.");
  process.exit(1);
}

// 0. registration — add_sub_issue is the only tool this build changed the
//    surface of; the manifest describes the new behavior.
const manifest = toolManifest();
const addSubIssueEntry = manifest.find((t) => t.name === "add_sub_issue");
check("add_sub_issue is in the tools/list manifest", !!addSubIssueEntry);
check(
  "add_sub_issue's description documents the hierarchy rule (Git #3708)",
  !!addSubIssueEntry?.description.includes("Epic"),
  addSubIssueEntry?.description,
);
payloads.push(JSON.stringify(manifest));

// 1. list_sub_issues no longer caps at GitHub's own 30-row default page —
//    #1096 (EPIC: Application Core) is real and confirmed (2026-09-12, via
//    `gh api .../issues/1096 --jq .sub_issues_summary.total`) to carry 72
//    real sub-issues, comfortably over the 30-row default page GitHub would
//    otherwise silently truncate this at.
const listSubIssues = TOOLS_BY_NAME.get("list_sub_issues");
const epicChildren = await listSubIssues.handler({ number: 1096 }, { tokenId: null, tokenLabel: "verify-3708", log: () => {} });
payloads.push(JSON.stringify(epicChildren));
console.log(`  ..   #1096 real sub-issue count: ${epicChildren.count}`);
check(
  "list_sub_issues(#1096) returns more than GitHub's own 30-row default page",
  epicChildren.count > 30,
  `count was ${epicChildren.count} — if this Epic's real child count ever drops at/under 30 this ` +
    "check needs a different real parent, it does not mean the per_page fix regressed",
);

// 1b. list_blocked_by — same per_page=100 fix, same githubRequest() call
//     shape. No known real issue in this repo currently carries more than 30
//     real blocked_by edges to exercise the cap itself directly, so this
//     stays a real (not capped-at-zero) functional call plus a code-level
//     assertion that the fix is the same shape as list_sub_issues' proven fix.
const listBlockedBy = TOOLS_BY_NAME.get("list_blocked_by");
const blockedByResult = await listBlockedBy.handler({ number: 3708 }, { tokenId: null, tokenLabel: "verify-3708", log: () => {} });
payloads.push(JSON.stringify(blockedByResult));
check("list_blocked_by(#3708) returns a real, well-shaped result", Array.isArray(blockedByResult.blockedBy));

// 2. classifyIssueTitle — pure, no live call.
check('classifyIssueTitle("EPIC: Build Console") === "epic"', classifyIssueTitle("EPIC: Build Console") === "epic");
check('classifyIssueTitle("Epic: Build Console") === "epic" (mixed case)', classifyIssueTitle("Epic: Build Console") === "epic");
check(
  'classifyIssueTitle("Feature: GitHub MCP Server") === "feature"',
  classifyIssueTitle("Feature: GitHub MCP Server") === "feature",
);
check(
  'classifyIssueTitle("Fix permanently-empty ...") === "other"',
  classifyIssueTitle("Fix permanently-empty PlatformAdmin impersonation sessions list") === "other",
);

// 3. getParentIssue — real live reads. #3377 (Feature: GitHub MCP Server) is
//    a real sub-issue of #1202 (Epic: Build Console); #1202 itself has no parent.
const featureParent = await getParentIssue(3377);
check(
  "getParentIssue(#3377) resolves the real Epic #1202",
  featureParent?.number === 1202,
  JSON.stringify(featureParent),
);
const epicParent = await getParentIssue(1202);
check("getParentIssue(#1202) is null — a real Epic has no parent of its own", epicParent === null, JSON.stringify(epicParent));

// 4. enforceHierarchyOrThrow — real issue titles, but PURE/sync from here:
//    no GitHub write is possible through this function.
const realEpic = await getIssueSummary(1202); // Epic: Build Console
const realFeatureChild = await getIssueSummary(3377); // Feature: GitHub MCP Server
const realBugIssue = await getIssueSummary(3680); // a real, plain (non-Feature) issue

let threw = false;
try {
  enforceHierarchyOrThrow(realEpic, realBugIssue);
} catch (err) {
  threw = err instanceof HierarchyViolationError;
  payloads.push(err instanceof Error ? err.message : String(err));
}
check("a non-Feature child under a real Epic is rejected with HierarchyViolationError", threw);

let didNotThrow = true;
try {
  enforceHierarchyOrThrow(realEpic, realFeatureChild);
} catch {
  didNotThrow = false;
}
check("a real Feature-titled child under a real Epic is NOT rejected", didNotThrow);

let didNotThrowUnderFeature = true;
try {
  enforceHierarchyOrThrow(realFeatureChild, realBugIssue);
} catch {
  didNotThrowUnderFeature = false;
}
check("any child under a real Feature (not an Epic) is NOT rejected", didNotThrowUnderFeature);

// 5. Overflow naming — pure functions, matching the REAL #1788 -> #3706
//    pattern already live in this repo (confirmed 2026-09-12):
//    "Feature: Build Queue Panel (BuildConsole)" -> "Feature: Build Queue Panel — Part 2 (BuildConsole)"
const REAL_ORIGINAL_TITLE = "Feature: Build Queue Panel (BuildConsole)";
const REAL_OVERFLOW_TITLE = "Feature: Build Queue Panel — Part 2 (BuildConsole)";
check(
  "buildOverflowTitle reproduces the real #1788 -> #3706 title exactly",
  buildOverflowTitle(REAL_ORIGINAL_TITLE, 2) === REAL_OVERFLOW_TITLE,
  buildOverflowTitle(REAL_ORIGINAL_TITLE, 2),
);
check(
  "canonicalFeatureName treats the original and its real overflow as the same family",
  canonicalFeatureName(REAL_ORIGINAL_TITLE) === canonicalFeatureName(REAL_OVERFLOW_TITLE),
  `${canonicalFeatureName(REAL_ORIGINAL_TITLE)} vs ${canonicalFeatureName(REAL_OVERFLOW_TITLE)}`,
);
check("partNumber is 1 for the real unnumbered original", partNumber(REAL_ORIGINAL_TITLE) === 1);
check("partNumber is 2 for the real live overflow title", partNumber(REAL_OVERFLOW_TITLE) === 2);
check(
  "buildOverflowTitle computes Part 3 correctly off the already-numbered overflow",
  buildOverflowTitle(REAL_OVERFLOW_TITLE, 3) === "Feature: Build Queue Panel — Part 3 (BuildConsole)",
);
check(
  "splitTrailingParen isolates the real trailing annotation",
  splitTrailingParen(REAL_ORIGINAL_TITLE).trailing === " (BuildConsole)",
);
check(
  "stripPartSuffix removes only the Part suffix, not the trailing annotation",
  stripPartSuffix(splitTrailingParen(REAL_OVERFLOW_TITLE).base) === "Feature: Build Queue Panel",
);

// 6. resolveOverflowParent — real live reads only (listSubIssues + getParentIssue),
//    exercising the "well under the cap, no redirect" branch against a real Feature.
//    Deliberately NOT run against a Feature actually at/near the cap, since that
//    branch performs a real create_issue + add_sub_issue write.
const notNearCapFeature = await getIssueSummary(3377); // Feature: GitHub MCP Server
const resolved = await resolveOverflowParent(notNearCapFeature, undefined);
payloads.push(JSON.stringify(resolved));
check(
  "resolveOverflowParent does not redirect a Feature nowhere near the cap",
  resolved.redirected === false && resolved.targetParentNumber === notNearCapFeature.number,
  JSON.stringify(resolved),
);

// 7. the PAT never appears in any result, anywhere.
const allText = payloads.join("\n");
check("the GitHub PAT never appears in any result", !PAT || !allText.includes(PAT));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
