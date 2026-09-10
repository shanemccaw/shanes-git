import type { ToolDef } from "./registry.ts";
import { githubRequest, normalizeIssue, repoPath, type RawGitHubIssue } from "../github.ts";
import { CONTEXT_SCHEMA_PROPERTY, requireContext } from "./args.ts";

/**
 * Creates a real issue in this repo. `milestone` is the milestone's real
 * *number* (e.g. `5` for "v1.1"), matching GitHub's own REST shape and the
 * `--milestone 5` convention already used elsewhere in this repo's own
 * dispatch tooling — not a title lookup.
 */
export const createIssueTool: ToolDef = {
  name: "create_issue",
  description:
    "Creates a new GitHub issue in this repo. Required: title, context (Git #3538 — a short " +
    "label identifying which chat/session/build is making this write; rejected before any " +
    "GitHub call if missing). Optional: body (markdown), milestone (the milestone's number, " +
    "e.g. 5 for v1.1 — not its title), labels (array of existing label names). Returns the " +
    "created issue's number, url, and full normalized shape.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The issue title." },
      body: { type: "string", description: "The issue body, markdown." },
      milestone: { type: "integer", description: "Milestone number (e.g. 5), not its title." },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Existing label names to apply.",
      },
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["title", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) throw new Error("create_issue requires a non-empty `title`");

    const body: Record<string, unknown> = { title };
    if (typeof args.body === "string") body.body = args.body;
    if (typeof args.milestone === "number") body.milestone = args.milestone;
    if (Array.isArray(args.labels)) {
      const labels = args.labels.filter((l): l is string => typeof l === "string");
      if (labels.length) body.labels = labels;
    }

    const { data } = await githubRequest<RawGitHubIssue>("POST", `${repoPath()}/issues`, body);
    return normalizeIssue(data);
  },
};
