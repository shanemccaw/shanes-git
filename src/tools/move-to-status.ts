import type { ToolDef } from "./registry.ts";
import { githubGraphQL, GitHubError } from "../github.ts";
import { resolveRepo } from "../env.ts";
import { CONTEXT_SCHEMA_PROPERTY, REPO_SCHEMA_PROPERTY, requireContext } from "./args.ts";

/**
 * Shane's real Projects v2 board ("Shane McCaw Consulting"). Same ids already
 * verified live and in production use by `artifacts/api-server/src/routes/
 * admin-build-tracker.ts`'s `pushStatusToProjects()` — re-used here rather than
 * re-derived, per that file's own note: NOT STABLE ACROSS TIME, re-verify with
 * a read-only `gh api graphql` node lookup if this ever silently stops moving
 * cards, don't assume the code is broken.
 */
const PROJECT_V2_ID = "PVT_kwHOEiBDdc4BeoiY";
const PROJECT_V2_STATUS_FIELD_ID = "PVTSSF_lAHOEiBDdc4BeoiYzhZBRB0";

/**
 * The restricted status set this tool is scoped to (issue #3395's own body:
 * "Batter Up / Backlog / AI Batter Up / Ask Shane / Done"). Real board option
 * ids, queried live via `gh api graphql` against the Status field above —
 * NOT the different backlog/in_progress/done trio admin-build-tracker.ts
 * writes; this is a separate, smaller, explicitly-named vocabulary. Other real
 * columns exist on the board (In review, Architecting, In progress, Need to
 * Test, Zoho, EngageBay, Shane Declined, Park, Verifying, Crashed) but this
 * tool deliberately does not expose them — CLAUDE.md's board-status
 * conventions (e.g. "AI Batter Up" for filed findings, never "Batter Up"
 * directly) reserve several of those transitions for Shane's own review step.
 */
export const STATUS_OPTION_ID: Record<string, string> = {
  "Batter Up": "09b1927f",
  "Backlog": "63cc47c8",
  "AI Batter Up": "a0296971",
  "Ask Shane": "404998bb",
  "Done": "0003ae3b",
};

export const ALLOWED_STATUSES = Object.keys(STATUS_OPTION_ID);

const ISSUE_NODE_AND_PROJECT_ITEM_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
        projectItems(first: 20) {
          nodes { id project { id } }
        }
      }
    }
  }
`;

const ADD_PROJECT_V2_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

const UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`;

interface IssueNodeAndProjectItemResult {
  repository: {
    issue: {
      id: string;
      projectItems: { nodes: Array<{ id: string; project: { id: string } }> };
    } | null;
  };
}

/**
 * The real core of `move_to_status` — Git #3395. Moves a real issue (or epic;
 * an epic is itself a GitHub issue) to one of the five real board columns this
 * tool is scoped to. Adds the issue to the board first
 * (`addProjectV2ItemById`) if it isn't already a project item — a
 * freshly-created issue has none yet — then sets the Status field
 * (`updateProjectV2ItemFieldValue`). `status` is validated against the real,
 * restricted vocabulary before any GitHub call is made; an unknown string is
 * rejected cleanly with the real allowed list, never silently coerced or
 * defaulted.
 *
 * Exported (Git #3709) so `batch_move_to_status` can run this same real,
 * single-issue move per item — one bad `status`/number in a batch throws only
 * for that item, never the others.
 */
export async function moveIssueToStatus(
  number: number,
  status: string,
  repo?: { owner: string; repo: string },
): Promise<{ number: number; status: string; projectItemId: string; addedToBoard: boolean }> {
  if (!(status in STATUS_OPTION_ID)) {
    throw new Error(`"status" must be one of: ${ALLOWED_STATUSES.join(", ")} — got: ${JSON.stringify(status)}`);
  }
  const optionId = STATUS_OPTION_ID[status];
  const { owner, repo: repoName } = resolveRepo(repo);

  const data = await githubGraphQL<IssueNodeAndProjectItemResult>(ISSUE_NODE_AND_PROJECT_ITEM_QUERY, {
    owner,
    repo: repoName,
    number,
  });
  const issue = data.repository.issue;
  if (!issue) throw new GitHubError(404, `repo issue #${number}`, `Issue #${number} not found`);

  let itemId = issue.projectItems.nodes.find((n) => n.project.id === PROJECT_V2_ID)?.id;
  let addedToBoard = false;
  if (!itemId) {
    const added = await githubGraphQL<{ addProjectV2ItemById: { item: { id: string } } }>(
      ADD_PROJECT_V2_ITEM_MUTATION,
      { projectId: PROJECT_V2_ID, contentId: issue.id },
    );
    itemId = added.addProjectV2ItemById.item.id;
    addedToBoard = true;
  }

  await githubGraphQL(UPDATE_PROJECT_V2_ITEM_STATUS_MUTATION, {
    projectId: PROJECT_V2_ID,
    itemId,
    fieldId: PROJECT_V2_STATUS_FIELD_ID,
    optionId,
  });

  return { number, status, projectItemId: itemId, addedToBoard };
}

export const moveToStatusTool: ToolDef = {
  name: "move_to_status",
  description:
    "Moves a GitHub issue to one of the real Projects v2 board columns: " +
    ALLOWED_STATUSES.map((s) => `"${s}"`).join(", ") +
    ". Adds the issue to the board first if it isn't already an item on it. `status` must be " +
    "one of the exact strings above — anything else is rejected with the allowed list. " +
    "Required: context (Git #3538 — a short label identifying which chat/session/build is " +
    "making this write; rejected before any GitHub call if missing). Optional `repo` (Git " +
    "#3580) targets a different repo for the issue lookup — the board itself (PROJECT_V2_ID) " +
    "is one shared board and does not vary by repo; defaults to the server's configured repo.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1, description: "The GitHub issue number to move." },
      status: {
        type: "string",
        enum: ALLOWED_STATUSES,
        description: "The real board column to move it to.",
      },
      repo: REPO_SCHEMA_PROPERTY,
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "status", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const number = args.number;
    const status = args.status;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new Error(`"number" must be a positive integer GitHub issue number, got: ${JSON.stringify(number)}`);
    }
    if (typeof status !== "string") {
      throw new Error(
        `"status" must be one of: ${ALLOWED_STATUSES.join(", ")} — got: ${JSON.stringify(status)}`,
      );
    }
    return moveIssueToStatus(number, status, resolveRepo(args.repo));
  },
};
