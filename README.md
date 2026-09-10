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

## Tools

**Scaffold set (Git #3390)** — three tools prove the auth + PAT + audit spine:

- `server_status` — health; reports `patConfigured` as a boolean only (never the value).
- `github_whoami` — calls GitHub `GET /user` with the server-side PAT and returns only the
  resulting public identity + token scopes. Proves the credential works without exposing it.
- `get_recent_activity` — the audit trail of what each connected Claude has done.
- `close_issue` (Git #3394) — closes an issue with a real `state_reason` (`completed` |
  `not_planned`). `not_planned` is rejected before any GitHub call unless a non-empty `comment`
  is supplied, and that comment posts FIRST, then the issue closes — enforcing the repo's
  standing NOT_PLANNED-always-carries-a-comment rule (Git #2167) in the tool itself rather than
  trusting the caller to remember.
- `post_comment` / `list_comments` (Git #3393) — `post_comment(number, body)` posts a comment on
  an issue/PR verbatim, returning its id/htmlUrl/createdAt; `list_comments(number)` lists every
  comment oldest-first (paginates through all pages), matching the standing convention that a
  later comment may supersede an earlier one's stated state. Both share `postIssueComment()` /
  `listIssueComments()` in `src/github.ts` with `close_issue`'s comment plumbing.
- `move_to_status` (Git #3395) — `move_to_status(number, status)` moves an issue (or epic — an
  epic is itself an issue) to one of the real Projects v2 board columns this tool is scoped to:
  `Batter Up`, `Backlog`, `AI Batter Up`, `Ask Shane`, `Done`. Adds the issue to the board first
  (`addProjectV2ItemById`) if it isn't already a project item, then sets the Status field
  (`updateProjectV2ItemFieldValue`). `status` is validated against that exact 5-value vocabulary
  before any GitHub call is made — an unrecognized string is rejected with the real allowed list,
  never silently coerced. Projects v2 has no REST surface at all, so this is the first tool to use
  `githubGraphQL()` in `src/github.ts` — same server-side-only-PAT discipline as `githubRequest()`,
  just against `https://api.github.com/graphql`. Board/field ids
  (`PVT_kwHOEiBDdc4BeoiY` / `PVTSSF_lAHOEiBDdc4BeoiYzhZBRB0`) and their real option ids are the
  same ones already live in `artifacts/api-server/src/routes/admin-build-tracker.ts` — re-verify
  with a read-only `gh api graphql` node lookup if this ever stops moving cards, per that file's
  own "NOT STABLE ACROSS TIME" note.

**Sub-issue hierarchy + blocked_by dependencies (Git #3392):**

- `add_sub_issue(parent_number, child_number)` — resolves the child's real internal `id`
  internally; caller only ever passes issue numbers. Fails with GitHub's own error if the child
  already has a different parent (GitHub's one-parent-at-a-time rule) — remove it there first.
- `remove_sub_issue(parent_number, child_number)` — detaches a sub-issue, for re-parenting.
- `list_sub_issues(number)` — the real, current sub-issue list of one issue.
- `set_blocked_by(number, blocker_numbers[])` — makes `number`'s real `blocked_by` edges match
  `blocker_numbers[]` exactly: adds missing edges, removes stale ones no longer in the list (pass
  `[]` to clear). A true "set", not just an append — the CLAUDE.md Git #1987 rule that a stale
  edge pointing at a closed/wrong issue silently reads as "clear" is exactly what this reconciles.
- `list_blocked_by(number)` — real current blockers of `number` + their live GitHub state.

The remaining real GitHub tools — `create_issue`, `get_issue`, `update_issue`, and
`search_issues` — are the other sibling sub-issues of Feature #3377. Each adds a `ToolDef` file
under `src/tools/`, appends it to `ALL_TOOLS` in `src/tools/index.ts`, and calls
`githubRequest()`/`githubGraphQL()` from `src/github.ts` (the one place the PAT is touched).
Nothing else about the server changes.

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
