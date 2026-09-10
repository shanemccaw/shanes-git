# @workspace/github-mcp-server

A small MCP server that exposes real GitHub operations to a Claude conversation **while holding
the GitHub PAT server-side**, so the live credential never enters chat history. Git #3390, the
foundation of **Feature #3377** (GitHub MCP Server — server-side PAT, no token in chat).

Modeled on Shane's Life's own bearer-token MCP pattern (`web/shanes-life`, see
`web/shanes-life/docs/mcp-connection-guide.md`): JSON-RPC 2.0 over Streamable HTTP, bearer-token
auth, **no OAuth server**.

## Why

Today a chat that needs to touch GitHub pastes a raw PAT into the message and runs `curl`/`git`.
That puts the live credential in plaintext in conversation history — searchable and re-surfaceable.
This server removes that: the PAT is consumed **internally** by the server and is never returned
in a tool call input, a tool call result, a log line, or an audit row.

## Two credentials — do not confuse them

- **The GitHub PAT** — held server-side only, read from `GITHUB_MCP_PAT` (or the repo's existing
  `GIT_PAT`) in the repo-root `.env.local` / the environment. The server uses it to talk to GitHub.
  It is never sent to a client.
- **The MCP bearer token (`ghmcp_…`)** — what a Claude connection presents to reach *this* server.
  Minted once, shown once, only its SHA-256 stored (`github_mcp_tokens`). Revocable. Every call it
  makes lands in the Recent-Activity trail (`github_mcp_activity`) with its label.

## Run it

```
# from repo root — deps (pg, pino) are already in the workspace store; no install needed
node artifacts/github-mcp-server/src/index.ts
# listens on http://127.0.0.1:8770/mcp by default (GITHUB_MCP_HOST / GITHUB_MCP_PORT to override)
```

## Mint a token (the admin surface)

```
cd artifacts/github-mcp-server
npm run mint-token -- --label "Claude Desktop"   # prints the token ONCE + a `claude mcp add` line
npm run list-tokens                              # never prints secrets
npm run revoke-token -- --id 3
```

A BuildConsole Settings UI can call the same `issueToken()` later; this CLI is what mints the
first token before any UI exists.

## Connect

```
claude mcp add --transport http github-mcp http://127.0.0.1:8770/mcp \
  --header "Authorization: Bearer ghmcp_<the minted token>"
```

Clients with no header field can use the capability-URL form: `POST /mcp/t/<token>`.

## Tools (scaffold set)

This issue lands only the **foundation**. Three tools prove the auth + PAT + audit spine:

- `server_status` — health; reports `patConfigured` as a boolean only (never the value).
- `github_whoami` — calls GitHub `GET /user` with the server-side PAT and returns only the
  resulting public identity + token scopes. Proves the credential works without exposing it.
- `get_recent_activity` — the audit trail of what each connected Claude has done.
- `close_issue` (Git #3394) — closes an issue with a real `state_reason` (`completed` |
  `not_planned`). `not_planned` is rejected before any GitHub call unless a non-empty `comment`
  is supplied, and that comment posts FIRST, then the issue closes — enforcing the repo's
  standing NOT_PLANNED-always-carries-a-comment rule (Git #2167) in the tool itself rather than
  trusting the caller to remember.

The remaining real GitHub tools — `create_issue`, `get_issue`, `update_issue`, `search_issues`,
`add_sub_issue`/`remove_sub_issue`/`list_sub_issues`, `set_blocked_by`/`list_blocked_by`,
`post_comment`/`list_comments`, and `move_to_status` — are the sibling sub-issues of Feature
#3377. Each adds a `ToolDef` file under
`src/tools/`, appends it to `ALL_TOOLS` in `src/tools/index.ts`, and calls `githubRequest()` from
`src/github.ts` (the one place the PAT is touched). Nothing else about the server changes.

## Verify

```
npm run smoke   # boots the server, mints a token, asserts auth works, a bad/revoked token is
                # rejected 401, and the PAT never appears in any response body
```

## Schema

`github_mcp_tokens` and `github_mcp_activity` — Drizzle definitions in
`lib/db/src/schema/index.ts`; created by
`lib/db/migrations/manual/2026-09-10-github-mcp-tokens-and-activity-3390.sql` (already applied to
local Postgres; a Replit/Staging line is on the #1630 checklist).

## Logging

`admin.mcp` channel for server activity, `audit` channel for the Recent-Activity trail — the
locked platform taxonomy (see repo `CLAUDE.md`).
