import type { ToolDef } from "./registry.ts";
import { serverStatusTool } from "./server-status.ts";
import { githubWhoamiTool } from "./github-whoami.ts";
import { getRecentActivityTool } from "./get-recent-activity.ts";
import { closeIssueTool } from "./close-issue.ts";
import { postCommentTool } from "./post-comment.ts";
import { listCommentsTool } from "./list-comments.ts";

/**
 * Every tool this server exposes. The scaffold set (Git #3390) — the three
 * foundational tools that prove the auth + server-side-PAT + audit spine
 * end-to-end — plus the real GitHub tools landing as sibling sub-issues of
 * Feature #3377 (close_issue is Git #3394, post_comment/list_comments is Git
 * #3393). Each adds its own ToolDef file here and appends it to this list.
 * Nothing else about the server changes when a tool is added.
 */
export const ALL_TOOLS: ToolDef[] = [
  serverStatusTool,
  githubWhoamiTool,
  getRecentActivityTool,
  closeIssueTool,
  postCommentTool,
  listCommentsTool,
];

export const TOOLS_BY_NAME: Map<string, ToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolManifest(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
