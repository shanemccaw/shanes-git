import type { ToolDef } from "./registry.ts";
import { getViewer } from "../github.ts";

/**
 * Proves the server-side PAT actually works — by using it. Calls GitHub's
 * GET /user with the internally-held token and returns ONLY the resulting public
 * identity (login, id, html_url, type) plus the token's reported scopes. The PAT
 * itself never appears in the arguments or the result: this is the concrete
 * demonstration the issue's verification asks for — "the token itself never
 * appears in any tool call input/output."
 */
export const githubWhoamiTool: ToolDef = {
  name: "github_whoami",
  description:
    "Returns the GitHub account the server-side PAT authenticates as (login, id, profile URL, " +
    "and the token's scopes). Proves the credential works without ever exposing it. No arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const viewer = await getViewer();
    return {
      login: viewer.login,
      id: viewer.id,
      htmlUrl: viewer.htmlUrl,
      type: viewer.type,
      scopes: viewer.scopes,
    };
  },
};
