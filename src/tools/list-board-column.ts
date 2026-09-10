import type { ToolDef } from "./registry.ts";
import { githubGraphQL } from "../github.ts";

/**
 * Shane's real Projects v2 board ("Shane McCaw Consulting"). Same id already
 * verified live and reused by `move-to-status.ts` / `get-board-status.ts` —
 * NOT STABLE ACROSS TIME, re-verify with a read-only `gh api graphql` node
 * lookup if this ever silently stops resolving, don't assume the code is
 * broken.
 */
const PROJECT_V2_ID = "PVT_kwHOEiBDdc4BeoiY";

/**
 * The same restricted status vocabulary `move_to_status`/`get_board_status`
 * are scoped to (issue #3395's own body). Real board option NAMES, not ids —
 * this tool filters by the field's displayed `name`, matching what
 * `get_board_status` already returns.
 */
const ALLOWED_STATUSES = ["Batter Up", "Backlog", "AI Batter Up", "Ask Shane", "Done"];

const PROJECT_ITEMS_PAGE_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          nodes {
            content {
              ... on Issue {
                number
                title
                state
                parent {
                  number
                  title
                  parent { number title }
                }
              }
            }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface ParentRef {
  number: number;
  title: string;
  parent: { number: number; title: string } | null;
}

interface ProjectItemsPageResult {
  node: {
    items: {
      nodes: Array<{
        content: { number: number; title: string; state: string; parent: ParentRef | null } | null;
        fieldValueByName: { name: string } | null;
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

export interface BoardColumnItem {
  number: number;
  title: string;
  epicNumber: number | null;
  epicTitle: string | null;
}

/**
 * Walks an item's real `parent` / `parent.parent` chain (mirrors #3336's
 * two-level Feature→Epic walk) to find the top ancestor — whichever `parent`
 * is null one level up. An issue with no parent at all is genuinely
 * un-parented (real "No Epic" case, not an error) and resolves to
 * `{ epicNumber: null, epicTitle: null }`.
 */
function resolveTopEpic(parent: ParentRef | null): { epicNumber: number | null; epicTitle: string | null } {
  if (!parent) return { epicNumber: null, epicTitle: null };
  if (parent.parent) return { epicNumber: parent.parent.number, epicTitle: parent.parent.title };
  return { epicNumber: parent.number, epicTitle: parent.title };
}

/**
 * `list_board_column(status, epicNumber?)` — Git #3549. The reverse direction
 * of every other board tool here: those go issue→project
 * (`move-to-status.ts`, `get-board-status.ts` both query
 * `issue(number) { projectItems { ... } }`); this one queries the project
 * node directly and returns every item currently sitting in one Status
 * column, paginating through the full board (`items(first: 100, after:
 * $cursor)`, following `pageInfo.hasNextPage` — a board can hold hundreds of
 * items, this does not cap at one page).
 *
 * Each matching item's top Epic is resolved from the same query's nested
 * `parent`/`parent.parent` chain (see `resolveTopEpic()`) — no extra
 * round-trip per item. An optional `epicNumber` filters the result set to
 * just that Epic's descendants, so "what's in AI Batter Up under Epic #1202"
 * is one real call instead of a text search plus N individual
 * `get_board_status` calls (the exact slow, error-prone workaround #3549's
 * own body documents hitting live).
 */
export const listBoardColumnTool: ToolDef = {
  name: "list_board_column",
  description:
    "Lists every real GitHub issue currently sitting in one Projects v2 board Status column: " +
    ALLOWED_STATUSES.map((s) => `"${s}"`).join(", ") +
    ". Paginates through the entire board (not capped at one page) and resolves each item's top " +
    "Epic from its real parent chain. Optional epicNumber filters the result to just that Epic's " +
    "descendants. Returns { status, epicNumber, items: [{ number, title, epicNumber, epicTitle }], " +
    "totalCount } — epicNumber/epicTitle are null for genuinely un-parented items, never omitted.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ALLOWED_STATUSES,
        description: "The real board column to list.",
      },
      epicNumber: {
        type: "integer",
        minimum: 1,
        description: "Optional — only return items whose resolved top Epic matches this issue number.",
      },
    },
    required: ["status"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const status = args.status;
    if (typeof status !== "string" || !ALLOWED_STATUSES.includes(status)) {
      throw new Error(`"status" must be one of: ${ALLOWED_STATUSES.join(", ")} — got: ${JSON.stringify(status)}`);
    }
    const epicNumberFilter = args.epicNumber;
    if (epicNumberFilter !== undefined) {
      if (
        typeof epicNumberFilter !== "number" ||
        !Number.isInteger(epicNumberFilter) ||
        epicNumberFilter < 1
      ) {
        throw new Error(
          `"epicNumber", when provided, must be a positive integer — got: ${JSON.stringify(epicNumberFilter)}`,
        );
      }
    }

    const items: BoardColumnItem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: ProjectItemsPageResult = await githubGraphQL<ProjectItemsPageResult>(
        PROJECT_ITEMS_PAGE_QUERY,
        { projectId: PROJECT_V2_ID, cursor },
      );
      const page = data.node?.items;
      if (!page) break;

      for (const node of page.nodes) {
        if (!node.content) continue; // draft/non-issue item, no real content to report
        if (node.fieldValueByName?.name !== status) continue;

        const { epicNumber, epicTitle } = resolveTopEpic(node.content.parent);
        if (epicNumberFilter !== undefined && epicNumber !== epicNumberFilter) continue;

        items.push({
          number: node.content.number,
          title: node.content.title,
          epicNumber,
          epicTitle,
        });
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return {
      status,
      epicNumber: epicNumberFilter ?? null,
      items,
      totalCount: items.length,
    };
  },
};
