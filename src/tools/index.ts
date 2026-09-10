import type { ToolDef } from "./registry.ts";
import { serverStatusTool } from "./server-status.ts";
import { githubWhoamiTool } from "./github-whoami.ts";
import { getRecentActivityTool } from "./get-recent-activity.ts";
import { closeIssueTool } from "./close-issue.ts";
import { createIssueTool } from "./create-issue.ts";
import { getIssueTool } from "./get-issue.ts";
import { updateIssueTool } from "./update-issue.ts";
import { searchIssuesTool } from "./search-issues.ts";
import { postCommentTool } from "./post-comment.ts";
import { listCommentsTool } from "./list-comments.ts";
import { addSubIssueTool } from "./add-sub-issue.ts";
import { removeSubIssueTool } from "./remove-sub-issue.ts";
import { listSubIssuesTool } from "./list-sub-issues.ts";
import { setBlockedByTool } from "./set-blocked-by.ts";
import { listBlockedByTool } from "./list-blocked-by.ts";
import { moveToStatusTool } from "./move-to-status.ts";
import { getBoardStatusTool } from "./get-board-status.ts";

/**
 * Every tool this server exposes. The scaffold set (Git #3390) proved the
 * auth + server-side-PAT + audit spine end-to-end. On top of it: core issue
 * operations (Git #3391), close_issue (Git #3394), post_comment/list_comments
 * (Git #3393), the sub-issue hierarchy + blocked_by dependency set (Git
 * #3392), and move_to_status (Git #3395) — the real GitHub tools landing as
 * sibling sub-issues of Feature #3377. Each adds its own ToolDef file here
 * and appends it to this list. Nothing else about the server changes when a
 * tool is added.
 */
export const ALL_TOOLS: ToolDef[] = [
  serverStatusTool,
  githubWhoamiTool,
  getRecentActivityTool,
  createIssueTool,
  getIssueTool,
  updateIssueTool,
  searchIssuesTool,
  closeIssueTool,
  postCommentTool,
  listCommentsTool,
  addSubIssueTool,
  removeSubIssueTool,
  listSubIssuesTool,
  setBlockedByTool,
  listBlockedByTool,
  moveToStatusTool,
  getBoardStatusTool,
];

export const TOOLS_BY_NAME: Map<string, ToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolManifest(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
