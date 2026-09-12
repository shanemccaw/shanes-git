import type { ToolDef } from "./registry.ts";
import { resolveRepo } from "../env.ts";
import {
  CONTENTS_DIRECTORY_MAX_ENTRIES,
  fetchContents,
  normalizeContentEntry,
  type RawContentEntry,
} from "../github.ts";
import { REPO_SCHEMA_PROPERTY } from "./args.ts";

/**
 * Lists one real directory in the repo (Git #3697) — the navigation half of
 * the file-read capability `shanes-git` had none of. `get_file_contents` is
 * only useful to a chat that already knows the exact path; this is how it
 * finds one, starting from the repo root with no `path` at all.
 *
 * Same Contents API, same server-side PAT, read-only (no `context`).
 *
 * Honest limits: GitHub's Contents API caps a directory listing at 1000
 * entries with no cursor of its own, so a directory at exactly that count is
 * reported with `truncated: true` rather than silently presented as complete.
 */
export const listDirectoryTool: ToolDef = {
  name: "list_directory",
  description:
    "Lists the real contents of one directory in the repository — every entry's name, path, type " +
    "('file' | 'dir' | 'symlink' | 'submodule') and size. Omit `path` (or pass '') for the repo " +
    "root. Non-recursive: list a subdirectory by calling again with its path. `ref` optionally " +
    "pins a branch, tag or commit SHA. This is how a chat navigates the real repo structure " +
    "before calling get_file_contents, without having to know exact paths up front.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Repo-root-relative directory path, e.g. 'artifacts/github-mcp-server/src'. " +
          "Omit or pass '' for the repo root. Case-sensitive; '..' is rejected.",
      },
      ref: {
        type: "string",
        description:
          "Optional branch name, tag, or commit SHA to list at. Defaults to the repo's default branch.",
      },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args) => {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : undefined;
    const target = resolveRepo(args.repo);

    const data = await fetchContents(path, ref, target);

    if (!Array.isArray(data)) {
      const entry = data as RawContentEntry;
      throw new Error(
        `"${path || "/"}" is a ${entry.type}, not a directory — use get_file_contents to read it.`,
      );
    }

    const entries = data.map(normalizeContentEntry);
    const truncated = entries.length >= CONTENTS_DIRECTORY_MAX_ENTRIES;

    return {
      path: path.replace(/^\.\//, "").replace(/^\/+|\/+$/g, ""),
      repo: `${target.owner}/${target.repo}`,
      ref: ref ?? null,
      entryCount: entries.length,
      truncated,
      note: truncated
        ? `GitHub's Contents API returns at most ${CONTENTS_DIRECTORY_MAX_ENTRIES} entries per ` +
          "directory and offers no pagination for this endpoint, so this listing may be " +
          "incomplete. Narrow to a subdirectory, or use search_code to find a specific file."
        : null,
      entries,
    };
  },
};
