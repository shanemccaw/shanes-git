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
import { listBoardColumnTool } from "./list-board-column.ts";
import { getFileContentsTool } from "./get-file-contents.ts";
import { listDirectoryTool } from "./list-directory.ts";
import { searchCodeTool } from "./search-code.ts";
import { batchReparentSubIssuesTool } from "./batch-reparent-sub-issues.ts";
import { batchMoveToStatusTool } from "./batch-move-to-status.ts";
import { batchCloseIssuesTool } from "./batch-close-issues.ts";

/**
 * Every tool this server exposes. The scaffold set (Git #3390) proved the
 * auth + server-side-PAT + audit spine end-to-end. On top of it: core issue
 * operations (Git #3391), close_issue (Git #3394), post_comment/list_comments
 * (Git #3393), the sub-issue hierarchy + blocked_by dependency set (Git
 * #3392), move_to_status (Git #3395), get_board_status (Git #3542),
 * list_board_column (Git #3549), and the repository-contents set —
 * get_file_contents / list_directory / search_code (Git #3697), the first
 * tools here that read real CODE rather than tracker metadata, and the real
 * batch tools — batch_reparent_sub_issues / batch_move_to_status /
 * batch_close_issues (Git #3709) — each running its existing single-item
 * counterpart's real logic once per item, sequentially, with independent
 * per-item success/failure reporting rather than an all-or-nothing
 * transaction. All landing as sibling sub-issues of Feature #3377. Each adds
 * its own ToolDef file here and appends it to this list. Nothing else about
 * the server changes when a tool is added.
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
  listBoardColumnTool,
  getFileContentsTool,
  listDirectoryTool,
  searchCodeTool,
  batchReparentSubIssuesTool,
  batchMoveToStatusTool,
  batchCloseIssuesTool,
];

export const TOOLS_BY_NAME: Map<string, ToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolManifest(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
