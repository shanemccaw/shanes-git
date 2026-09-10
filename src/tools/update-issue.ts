import type { ToolDef } from "./registry.ts";
import { githubRequest, normalizeIssue, repoPath, type RawGitHubIssue } from "../github.ts";

/**
 * Patches an existing issue. Every field besides `number` is optional and
 * only sent if actually provided — an omitted field is left untouched on
 * GitHub's side (this is a real PATCH, not a full replace). `labels`, when
 * given, REPLACES the issue's full label set (GitHub's own PATCH semantics) —
 * not an add/remove diff.
 */
export const updateIssueTool: ToolDef = {
  name: "update_issue",
  description:
    "Updates an existing GitHub issue in this repo. Required: number. Optional: title, body " +
    "(markdown), milestone (its number, e.g. 5 — or null to clear it), labels (array of existing " +
    "label names — REPLACES the issue's full label set, not an add/remove diff), state " +
    "('open' or 'closed'). Only fields you provide are changed. Returns the updated issue.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The issue number to update." },
      title: { type: "string" },
      body: { type: "string" },
      milestone: {
        type: ["integer", "null"],
        description: "Milestone number (e.g. 5), or null to clear it.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Existing label names — replaces the full label set.",
      },
      state: { type: "string", enum: ["open", "closed"] },
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = typeof args.number === "number" ? args.number : Number(args.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("update_issue requires a positive integer `number`");
    }

    const patch: Record<string, unknown> = {};
    if (typeof args.title === "string") patch.title = args.title;
    if (typeof args.body === "string") patch.body = args.body;
    if (args.milestone === null || typeof args.milestone === "number") patch.milestone = args.milestone;
    if (Array.isArray(args.labels)) {
      patch.labels = args.labels.filter((l): l is string => typeof l === "string");
    }
    if (args.state === "open" || args.state === "closed") patch.state = args.state;

    if (Object.keys(patch).length === 0) {
      throw new Error(
        "update_issue requires at least one field to change (title, body, milestone, labels, state)",
      );
    }

    const { data } = await githubRequest<RawGitHubIssue>(
      "PATCH",
      `${repoPath()}/issues/${number}`,
      patch,
    );
    return normalizeIssue(data);
  },
};
