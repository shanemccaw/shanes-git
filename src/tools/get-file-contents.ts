import type { ToolDef } from "./registry.ts";
import { resolveRepo } from "../env.ts";
import {
  CONTENTS_INLINE_MAX_BYTES,
  fetchContents,
  looksBinary,
  type RawContentEntry,
} from "../github.ts";
import { REPO_SCHEMA_PROPERTY } from "./args.ts";

/**
 * Reads one real file's actual content out of the repo (Git #3697).
 *
 * Before this, `shanes-git`'s entire tool surface was issue/board metadata —
 * a chat connected to it could manage the tracker but could not see a single
 * line of the code it was discussing. That was survivable only while a chat
 * could be handed a raw PAT and `git clone` the repo itself; once the repo
 * went private and PAT-in-chat was retired (#3556/#3559) nothing replaced the
 * capability. This is the replacement, and it keeps the credential where
 * #3556 put it: the same server-side `GITHUB_MCP_PAT` every write tool already
 * uses, never passed through chat.
 *
 * Read-only, so no `context` argument (Git #3538's convention).
 *
 * Honest size handling (the issue's own item 4): GitHub's Contents API only
 * returns inline content up to ~1 MB. Above that it hands back the entry's
 * metadata with `content: ""` and `encoding: "none"` — which decoded naively
 * would look exactly like a real, empty file. This tool never does that: it
 * reports `truncated: true` with the real byte size and the real
 * `downloadUrl`, and says so in `note`.
 */
export const getFileContentsTool: ToolDef = {
  name: "get_file_contents",
  description:
    "Reads one real file's actual text content from the repository, at a given repo-root-relative " +
    "path. Uses GitHub's Contents API with the server-side PAT, so it reads the private repo " +
    "without any credential entering chat. `ref` optionally pins a branch, tag or commit SHA " +
    "(default branch when omitted). Returns the real decoded text in `content`. A file over " +
    "GitHub's ~1MB inline limit, or a binary file, returns `content: null` with `truncated`/" +
    "`binary` set and a real `downloadUrl` instead of fake or mangled text — it never silently " +
    "truncates. Point it at a directory and it says so and tells you to use list_directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Repo-root-relative path to a file, e.g. 'artifacts/api-server/src/index.ts'. " +
          "Case-sensitive. Leading './' or '/' is tolerated; '..' is rejected.",
      },
      ref: {
        type: "string",
        description:
          "Optional branch name, tag, or commit SHA to read at. Defaults to the repo's default branch.",
      },
      repo: REPO_SCHEMA_PROPERTY,
    },
    required: ["path"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) throw new Error("get_file_contents requires a non-empty `path`");
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : undefined;
    const target = resolveRepo(args.repo);

    const data = await fetchContents(path, ref, target);

    if (Array.isArray(data)) {
      throw new Error(
        `"${path}" is a directory, not a file — use list_directory to list its ${data.length} entries.`,
      );
    }

    const entry = data as RawContentEntry;
    const base = {
      path: entry.path,
      repo: `${target.owner}/${target.repo}`,
      ref: ref ?? null,
      sha: entry.sha,
      size: entry.size,
      type: entry.type,
      htmlUrl: entry.html_url,
      downloadUrl: entry.download_url,
    };

    if (entry.type === "submodule") {
      return {
        ...base,
        content: null,
        encoding: null,
        truncated: false,
        binary: false,
        note:
          "This path is a git submodule, not a file in this repository. Its contents live in " +
          `${entry.submodule_git_url ?? "another repository"}.`,
      };
    }

    if (entry.type === "symlink") {
      return {
        ...base,
        content: null,
        encoding: null,
        truncated: false,
        binary: false,
        note: `This path is a symlink pointing at "${entry.target ?? "(unknown target)"}". Read that path instead.`,
      };
    }

    // Over GitHub's inline limit the API returns metadata with encoding "none"
    // and an empty content string. Reporting that as an empty file would be a lie.
    if (entry.encoding !== "base64" || typeof entry.content !== "string") {
      return {
        ...base,
        content: null,
        encoding: entry.encoding ?? null,
        truncated: true,
        binary: false,
        note:
          `File is ${entry.size} bytes, over GitHub's ~${CONTENTS_INLINE_MAX_BYTES}-byte Contents API ` +
          "inline limit, so no content was returned. Fetch the raw bytes from `downloadUrl` " +
          "instead — this tool returns no partial/truncated text.",
      };
    }

    const buf = Buffer.from(entry.content, "base64");

    if (looksBinary(buf)) {
      return {
        ...base,
        content: null,
        encoding: "base64",
        truncated: false,
        binary: true,
        note:
          "File is binary (a NUL byte appears in its first 8 KiB), so it has no meaningful text " +
          "representation. Use `downloadUrl` if the raw bytes are genuinely needed.",
      };
    }

    return {
      ...base,
      content: buf.toString("utf8"),
      encoding: "utf-8",
      truncated: false,
      binary: false,
      note: null,
    };
  },
};
