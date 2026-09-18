import type { ToolDef } from "./registry.ts";
import { addIssueLabel, getIssueLabels, removeIssueLabel } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext } from "./args.ts";

/**
 * `add_label` / `remove_label` — the real true-delta label tools (Feature
 * #4692 / #4697). `update_issue`'s `labels` param is GitHub's own full-REPLACE
 * PATCH: a caller that passes it wipes every other real label (`blocked`,
 * `Shane To-Do`, …) unless it re-sends the entire current set — confirmed
 * dangerous by #4686. These two tools instead read the issue's real current
 * labels FIRST and change only the one-label delta, never touching the rest.
 *
 * This is purely additive — `update_issue`'s existing full-replace `labels`
 * param is left working exactly as-is for any real caller that deliberately
 * wants a full replace. Both tools require `context` (Git #3538) like every
 * other write tool, and accept the optional `repo` override (Git #3580).
 */

function requireLabelArgs(args: Record<string, unknown>): {
  number: number;
  label: string;
  repo: { owner: string; repo: string };
} {
  requireContext(args);
  const number = typeof args.number === "number" ? args.number : Number(args.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("`number` must be a positive integer issue number.");
  }
  const label = typeof args.label === "string" ? args.label.trim() : "";
  if (!label) {
    throw new Error("`label` must be a non-empty label name.");
  }
  return { number, label, repo: resolveRepo(args.repo) };
}

export const addLabelTool: ToolDef = {
  name: "add_label",
  description:
    "Adds ONE label to a GitHub issue without disturbing its other labels — a true additive " +
    "delta, unlike update_issue's `labels` which REPLACES the whole set. Reads the issue's real " +
    "current labels first: if the label is already present it is a no-op (changed: false). " +
    "Returns { number, label, changed, labels } — `labels` is the issue's real resulting label " +
    "set. Required: number, label, context (Git #3538 — a short label identifying which " +
    "chat/session/build is making this write; rejected before any GitHub call if missing). " +
    "Optional `repo` (Git #3580) targets a different repo; defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1, description: "The issue number to label." },
      label: { type: "string", description: "The single label name to add." },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "label", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const { number, label, repo } = requireLabelArgs(args);
    const before = await getIssueLabels(number, repo);
    if (before.includes(label)) {
      return { number, label, changed: false, labels: before };
    }
    const labels = await addIssueLabel(number, label, repo);
    return { number, label, changed: true, labels };
  },
};

export const removeLabelTool: ToolDef = {
  name: "remove_label",
  description:
    "Removes ONE label from a GitHub issue without disturbing its other labels — a true " +
    "subtractive delta, unlike update_issue's `labels` which REPLACES the whole set. Reads the " +
    "issue's real current labels first: if the label is already absent it is a no-op " +
    "(changed: false). Returns { number, label, changed, labels } — `labels` is the issue's real " +
    "resulting label set. Required: number, label, context (Git #3538 — a short label identifying " +
    "which chat/session/build is making this write; rejected before any GitHub call if missing). " +
    "Optional `repo` (Git #3580) targets a different repo; defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1, description: "The issue number to remove the label from." },
      label: { type: "string", description: "The single label name to remove." },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "label", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const { number, label, repo } = requireLabelArgs(args);
    const before = await getIssueLabels(number, repo);
    if (!before.includes(label)) {
      return { number, label, changed: false, labels: before };
    }
    const labels = await removeIssueLabel(number, label, repo);
    return { number, label, changed: true, labels };
  },
};
