import type { ToolDef } from "./registry.ts";
import { githubGraphQL, GitHubError } from "../github.ts";

/**
 * Shane's real Projects v2 board ("Shane McCaw Consulting"). Same id already
 * verified live and reused by `move-to-status.ts` — NOT STABLE ACROSS TIME,
 * re-verify with a read-only `gh api graphql` node lookup if this ever
 * silently stops resolving, don't assume the code is broken.
 */
const PROJECT_V2_ID = "PVT_kwHOEiBDdc4BeoiY";

const ISSUE_BOARD_STATUS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
        projectItems(first: 20) {
          nodes {
            id
            project { id }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
`;

interface IssueBoardStatusResult {
  repository: {
    issue: {
      id: string;
      projectItems: {
        nodes: Array<{
          id: string;
          project: { id: string };
          fieldValueByName: { name: string } | null;
        }>;
      };
    } | null;
  };
}

const OWNER = "shanemccaw";
const REPO = "Shane-McCaw-MSP";

/**
 * `get_board_status(number)` — Git #3542. Read counterpart to `move_to_status`
 * (Git #3395): reads a real issue's current Projects v2 board column without
 * mutating anything. Reuses the same `githubGraphQL()` call and
 * `PROJECT_V2_ID` constant `move-to-status.ts` already established — same
 * "NOT STABLE ACROSS TIME" caveat applies.
 *
 * Read-only, no `context` required — matches every other read tool
 * (`get_issue`, `list_sub_issues`, etc.) per #3538, which only requires
 * `context` on write tools.
 *
 * Return shape: `{ number, onBoard, status }`. `onBoard: false` (not an
 * error) when the issue has no real Projects v2 item yet. `status: null`
 * when it's on the board but the Status field itself is unset.
 */
export const getBoardStatusTool: ToolDef = {
  name: "get_board_status",
  description:
    "Reads a GitHub issue's real current Projects v2 board column (the Status field) without " +
    "changing anything — the read counterpart to move_to_status. Returns " +
    "{ number, onBoard, status }: onBoard is false (not an error) if the issue isn't on the " +
    "board yet; status is null if it's on the board but Status is unset.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1, description: "The GitHub issue number to check." },
    },
    required: ["number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const number = args.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new Error(`"number" must be a positive integer GitHub issue number, got: ${JSON.stringify(number)}`);
    }

    const data = await githubGraphQL<IssueBoardStatusResult>(ISSUE_BOARD_STATUS_QUERY, {
      owner: OWNER,
      repo: REPO,
      number,
    });
    const issue = data.repository.issue;
    if (!issue) throw new GitHubError(404, `repo issue #${number}`, `Issue #${number} not found`);

    const item = issue.projectItems.nodes.find((n) => n.project.id === PROJECT_V2_ID);
    if (!item) {
      return { number, onBoard: false, status: null };
    }

    return { number, onBoard: true, status: item.fieldValueByName?.name ?? null };
  },
};
