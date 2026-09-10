import type { ToolDef } from "./registry.ts";
import { serverStatusTool } from "./server-status.ts";
import { githubWhoamiTool } from "./github-whoami.ts";
import { getRecentActivityTool } from "./get-recent-activity.ts";

/**
 * Every tool this server exposes. This is the SCAFFOLD set (Git #3390): the
 * three foundational tools that prove the auth + server-side-PAT + audit spine
 * end-to-end. The real GitHub issue/sub-issue/blocked_by/comment/close/board
 * tools are the sibling sub-issues of Feature #3377 — each adds its own ToolDef
 * file here and appends it to this list. Nothing else about the server changes
 * when a tool is added.
 */
export const ALL_TOOLS: ToolDef[] = [serverStatusTool, githubWhoamiTool, getRecentActivityTool];

export const TOOLS_BY_NAME: Map<string, ToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolManifest(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
