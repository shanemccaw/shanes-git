/**
 * Epic → Feature → Issue hierarchy enforcement + proactive cap overflow
 * (Git #3708, Feature #3377). Composes the raw GitHub calls in `github.ts`
 * into the two real behaviors `add_sub_issue` needs at write time:
 *
 *  1. `enforceHierarchyOrThrow` — reject a non-Feature child being added
 *     directly under an Epic (ask 2).
 *  2. `resolveOverflowParent` — when the requested parent is a Feature at or
 *     near GitHub's real 100-sub-issue cap, redirect onto an existing
 *     "<Feature> — Part N" sibling with room, or create the next one,
 *     rather than waiting for a hard 422 (ask 3).
 */
import {
  classifyIssueTitle,
  getParentIssue,
  listSubIssues,
  normalizeIssue,
  repoPath,
  githubRequest,
  addSubIssue as rawAddSubIssue,
  SUB_ISSUE_HARD_CAP,
  type IssueSummary,
  type RawGitHubIssue,
} from "./github.ts";

/** How near the real hard cap counts as "nearing" it (Git #3708, ask 3). */
export const SUB_ISSUE_OVERFLOW_THRESHOLD = 95;

export class HierarchyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HierarchyViolationError";
  }
}

/**
 * Enforces the Epic → Feature → Issue hierarchy BEFORE any sub-issue write.
 * A parent classified as an Epic may only take a Feature-titled child
 * directly — a plain bug/suggestion (or anything else not `Feature:`-titled)
 * must be parented under a Feature instead. Any other parent tier (Feature,
 * or unclassified) is unrestricted.
 */
export function enforceHierarchyOrThrow(parent: IssueSummary, child: IssueSummary): void {
  if (classifyIssueTitle(parent.title) !== "epic") return;
  if (classifyIssueTitle(child.title) === "feature") return;
  throw new HierarchyViolationError(
    `Refusing to add #${child.number} ("${child.title}") as a sub-issue of #${parent.number} ` +
      `("${parent.title}") — #${parent.number} is an Epic, and only a Feature-titled issue ` +
      `("Feature: ...") may be a direct child of an Epic. File #${child.number} under a real ` +
      `Feature instead (CLAUDE.md's "Feature-first, area epic as fallback" convention).`,
  );
}

/**
 * Splits a title into its real body and any trailing " (...)" annotation,
 * e.g. " (BuildConsole)". Exported for direct, live-data-free verification.
 */
export function splitTrailingParen(title: string): { base: string; trailing: string } {
  const m = title.match(/^(.*?)(\s+\([^()]*\))\s*$/);
  if (m) return { base: m[1], trailing: m[2] };
  return { base: title, trailing: "" };
}

/** Strips an existing " — Part N" (or " - Part N") suffix off a title's base. */
export function stripPartSuffix(base: string): string {
  return base.replace(/\s+[—-]\s*Part\s+\d+\s*$/i, "").trim();
}

/** The real identity a title's overflow family shares, ignoring Part-N numbering and any trailing annotation. */
export function canonicalFeatureName(title: string): string {
  return stripPartSuffix(splitTrailingParen(title).base).toLowerCase();
}

/** The real Part number a title carries — 1 for an unnumbered (original) title. */
export function partNumber(title: string): number {
  const m = splitTrailingParen(title).base.match(/[—-]\s*Part\s+(\d+)\s*$/i);
  return m ? Number(m[1]) : 1;
}

/** Builds the real "<canonical> — Part N<trailing annotation>" title, matching #3706/#3707's own pattern. */
export function buildOverflowTitle(requestedParentTitle: string, n: number): string {
  const { base, trailing } = splitTrailingParen(requestedParentTitle);
  return `${stripPartSuffix(base)} — Part ${n}${trailing}`;
}

async function createIssue(
  title: string,
  body: string,
  repo?: { owner: string; repo: string },
): Promise<IssueSummary> {
  const { data } = await githubRequest<RawGitHubIssue & { id: number }>(
    "POST",
    `${repoPath(repo)}/issues`,
    { title, body },
  );
  const normalized = normalizeIssue(data);
  return { number: normalized.number, id: data.id, title: normalized.title, state: normalized.state, htmlUrl: normalized.htmlUrl };
}

export interface ResolvedParent {
  targetParentNumber: number;
  redirected: boolean;
  reason: string | null;
}

/**
 * Resolves the real parent a child should land under, proactively steering
 * around GitHub's real 100-sub-issue hard cap (ask 3). Only applies when
 * `requestedParent` is itself Feature-titled — an Epic nearing its own cap
 * has no defined "Part N" sibling convention to redirect into (the issue's
 * own ask-3 title scopes this to a Feature), so an Epic parent is always
 * left as requested here.
 */
export async function resolveOverflowParent(
  requestedParent: IssueSummary,
  repo: { owner: string; repo: string } | undefined,
): Promise<ResolvedParent> {
  if (classifyIssueTitle(requestedParent.title) !== "feature") {
    return { targetParentNumber: requestedParent.number, redirected: false, reason: null };
  }

  const currentSubIssues = await listSubIssues(requestedParent.number, repo);
  if (currentSubIssues.length < SUB_ISSUE_OVERFLOW_THRESHOLD) {
    return { targetParentNumber: requestedParent.number, redirected: false, reason: null };
  }

  const epic = await getParentIssue(requestedParent.number, repo);
  if (!epic) {
    // No Epic to parent an overflow Feature under. Best effort: proceed as
    // requested — a genuine 422 from GitHub if truly full is an honest
    // failure to surface as-is, not one this function can safely paper over.
    return { targetParentNumber: requestedParent.number, redirected: false, reason: null };
  }

  const canonical = canonicalFeatureName(requestedParent.title);
  const epicChildren = await listSubIssues(epic.number, repo);
  const family = epicChildren.filter((c) => canonicalFeatureName(c.title) === canonical);
  if (!family.some((c) => c.number === requestedParent.number)) family.push(requestedParent);

  const siblings = family
    .filter((c) => c.number !== requestedParent.number)
    .sort((a, b) => partNumber(a.title) - partNumber(b.title));

  for (const sibling of siblings) {
    const siblingSubIssues = await listSubIssues(sibling.number, repo);
    if (siblingSubIssues.length < SUB_ISSUE_HARD_CAP) {
      return {
        targetParentNumber: sibling.number,
        redirected: true,
        reason:
          `#${requestedParent.number} is at/near its real ${SUB_ISSUE_HARD_CAP}-sub-issue cap ` +
          `(${currentSubIssues.length} children) — landed under existing overflow #${sibling.number} ` +
          `("${sibling.title}") instead.`,
      };
    }
  }

  // No existing sibling has room — create the next real "Part N" overflow Feature.
  const nextN = Math.max(1, ...family.map((c) => partNumber(c.title))) + 1;
  const newTitle = buildOverflowTitle(requestedParent.title, Math.max(nextN, 2));
  const created = await createIssue(
    newTitle,
    `Real overflow Feature — #${requestedParent.number} ("${requestedParent.title}") hit or neared ` +
      `GitHub's real hard ${SUB_ISSUE_HARD_CAP}-sub-issue cap. This Feature holds real sub-issues ` +
      `that no longer fit under #${requestedParent.number}. Auto-created by shanes-git (Git #3708).`,
    repo,
  );
  await rawAddSubIssue(epic.number, created.number, repo);

  return {
    targetParentNumber: created.number,
    redirected: true,
    reason:
      `#${requestedParent.number} is at/near its real ${SUB_ISSUE_HARD_CAP}-sub-issue cap ` +
      `(${currentSubIssues.length} children) — created new overflow #${created.number} ` +
      `("${newTitle}") under Epic #${epic.number} and landed the child there instead.`,
  };
}
