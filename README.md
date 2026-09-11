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
- `close_issue` (Git #3394) — `close_issue(number, state_reason, comment?, repo?)` closes an issue
  with a real `state_reason` (`completed` | `not_planned`). `not_planned` is rejected before any
  GitHub call unless a non-empty `comment` is supplied, and that comment posts FIRST, then the
  issue closes — enforcing the repo's standing NOT_PLANNED-always-carries-a-comment rule (Git
  #2167) in the tool itself rather than trusting the caller to remember.
- `post_comment` / `list_comments` (Git #3393) — `post_comment(number, body, repo?)` posts a
  comment on an issue/PR verbatim, returning its id/htmlUrl/createdAt; `list_comments(number,
  repo?)` lists every comment oldest-first (paginates through all pages), matching the standing
  convention that a later comment may supersede an earlier one's stated state. Both share
  `postIssueComment()` / `listIssueComments()` in `src/github.ts` with `close_issue`'s comment
  plumbing.
- `move_to_status` (Git #3395) — `move_to_status(number, status, repo?)` moves an issue (or epic — an
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
- `get_board_status` (Git #3542) — `get_board_status(number, repo?)` is the read counterpart
  `move_to_status` had none of: reads an issue's real current Projects v2 Status column without
  changing anything. Returns `{ number, onBoard, status }` — `onBoard: false` (not an error) if
  the issue has no project item yet, `status: null` if it's on the board but Status is unset.
  Reuses `move-to-status.ts`'s `githubGraphQL()` call and `PROJECT_V2_ID`; read-only, no
  `context` required.
- `list_board_column` (Git #3549) — `list_board_column(status, epicNumber?)` is the reverse
  direction of every tool above: those go issue→project (`issue(number) { projectItems { ... } }`);
  this one queries the `ProjectV2` node directly (`node(id: PROJECT_V2_ID) { ... on ProjectV2 {
  items(first: 100, after: $cursor) { ... } } }`) and returns every real item currently sitting in
  one Status column, paginating through the whole board (`pageInfo.hasNextPage` — not capped at one
  page). Each matching item's top Epic is resolved in the same query from its nested
  `parent`/`parent.parent` chain (mirrors #3336's two-level Feature→Epic walk) — whichever `parent`
  is null one level up is the real top ancestor; an issue with no parent at all is genuinely
  un-parented (`epicNumber`/`epicTitle`: `null`, not an error). The optional `epicNumber` filters
  the result to just that Epic's descendants. Returns `{ status, epicNumber, items: [{ number,
  title, epicNumber, epicTitle }], totalCount }`. Replaces the slow, error-prone workaround #3549
  found live: a text `search_issues` (GitHub's search doesn't know Projects v2 Status at all)
  followed by one `get_board_status` call per candidate to confirm which were actually on the
  column. Read-only, no `context` required.

**Sub-issue hierarchy + blocked_by dependencies (Git #3392):**

- `add_sub_issue(parent_number, child_number, repo?)` — resolves the child's real internal `id`
  internally; caller only ever passes issue numbers. Fails with GitHub's own error if the child
  already has a different parent (GitHub's one-parent-at-a-time rule) — remove it there first.
- `remove_sub_issue(parent_number, child_number, repo?)` — detaches a sub-issue, for re-parenting.
- `list_sub_issues(number, repo?)` — the real, current sub-issue list of one issue.
- `set_blocked_by(number, blocker_numbers[], repo?)` — makes `number`'s real `blocked_by` edges
  match `blocker_numbers[]` exactly: adds missing edges, removes stale ones no longer in the list
  (pass `[]` to clear). A true "set", not just an append — the CLAUDE.md Git #1987 rule that a
  stale edge pointing at a closed/wrong issue silently reads as "clear" is exactly what this
  reconciles.
- `list_blocked_by(number, repo?)` — real current blockers of `number` + their live GitHub state.

**Core issue operations (Git #3391)** — real reads/writes against issues:

- `create_issue(title, body?, milestone?, labels?, repo?)` — `milestone` is the milestone's real
  *number* (e.g. `5` for "v1.1"), not its title.
- `get_issue(number, repo?)`.
- `update_issue(number, title?, body?, milestone?, labels?, state?, repo?)` — only the fields you
  pass are changed; `labels`, when passed, replaces the issue's full label set (GitHub's own PATCH
  semantics), not an add/remove diff.
- `search_issues(query, perPage?, repo?)` — real passthrough to GitHub's own search query syntax
  (`is:open label:bug`, `milestone:"v1.1"`, free text, …), automatically scoped to the target repo
  with `repo:owner/name`. Same result shape as GitHub's own search API (`total_count` + items).

All four call `githubRequest()` from `src/github.ts` (the one place the PAT is touched) and return
a normalized issue shape (`normalizeIssue()`) — number, title, body, state, labels, milestone,
assignees, timestamps, comment count.

With `move_to_status` (Git #3395) landed above, every tool of Feature #3377's original design is
now shipped.

## Multi-repo `repo` parameter (Git #3580, Feature #3378)

Every tool above that actually looks up or writes an issue in a specific repo — `create_issue`,
`get_issue`, `update_issue`, `search_issues`, `close_issue`, `post_comment`, `list_comments`,
`add_sub_issue`, `remove_sub_issue`, `list_sub_issues`, `set_blocked_by`, `list_blocked_by`,
`move_to_status`, `get_board_status` — now accepts an **optional** `repo` argument, `"owner/repo"`
shape (e.g. `"shanemccaw/some-other-repo"`).

- **Omitted or empty → full backward compatibility.** Every existing call site keeps resolving to
  exactly what it did before this: the `GITHUB_MCP_REPO` env var, defaulting to
  `shanemccaw/Shane-McCaw-MSP`. `src/env.ts`'s `resolveRepo(repoArg)` is the one shared resolver
  every tool calls.
- **Malformed `repo` is rejected before any GitHub call** — same `"must be owner/repo, got: ..."`
  validation `githubRepo()`'s own env-var parsing already used, now shared via
  `parseOwnerRepo()`/`resolveRepo()`.
- **`add_sub_issue`/`remove_sub_issue`/`set_blocked_by` apply `repo` to every issue number they
  touch** (parent + child, or `number` + every blocker) — a single call targets one repo, not a
  cross-repo pairing.
- **The Projects v2 board itself does not vary by `repo`.** `move_to_status` and
  `get_board_status` use `repo` only to resolve *which repo's issue* to look up
  (`repository(owner: $owner, name: $repo) { issue(number: $number) { ... } }`); `PROJECT_V2_ID`
  and `PROJECT_V2_STATUS_FIELD_ID` stay the single shared constants they already were — this is
  the real one-shared-board design the issue's own body calls out.
- **`list_board_column` deliberately does NOT get a `repo` param.** It queries the `ProjectV2` node
  directly (`node(id: PROJECT_V2_ID) { ... }`), with no owner/repo issue lookup anywhere in its
  query — there is no per-call repo dimension to thread through it. Adding a `repo` argument that
  the handler never consults would be a fake, no-op parameter.
- **`server_status`, `github_whoami`, `get_recent_activity` also have no `repo` param**, for the
  same reason — none of them address a specific repo at all.
- **Real verification (2026-09-10):** `get_issue({ number: 3580 })` with no `repo` returned
  `shanemccaw/Shane-McCaw-MSP#3580` unchanged; the same call with `repo: "octocat/Hello-World"`
  returned that genuinely different public repo's real issue #1 — the connector's classic
  `GITHUB_MCP_PAT` isn't restricted to one repo, so this works today. A malformed `repo` string
  (`"not-a-valid-repo-string"`) was rejected pre-flight before any GitHub call fired.

## Required `context` on every write (Git #3538)

Every write ever made through this server authenticates as the same server-side PAT, so on GitHub
it always shows as authored by `shanemccaw` regardless of which chat/session actually made the
change — there was no way to trace which chat did what. Every real write tool — `create_issue`,
`update_issue`, `add_sub_issue`, `remove_sub_issue`, `set_blocked_by`, `post_comment`,
`close_issue`, `move_to_status` — now requires a `context` string arg. Read-only tools
(`get_issue`, `search_issues`, `list_sub_issues`, `list_blocked_by`, `list_comments`,
`get_recent_activity`, `server_status`, `github_whoami`, `get_board_status`,
`list_board_column`) are untouched —
nothing to trace on a read.

- **Required, not optional.** A missing or empty `context` is rejected in the handler before any
  GitHub API call fires — the same pre-flight-reject pattern #3394 already established for a
  commentless NOT_PLANNED close. `src/tools/args.ts`'s `requireContext()` is the one shared check
  every write tool calls first.
- **Exact shape — a real, reasoned call on the issue's own open question:** a free-text string, no
  fixed vocabulary or required format. A build dispatched by BuildConsole has a real numeric
  buildId (e.g. `"build-2207"`); a raw interactive chat has no such id and would be forced into a
  shape that doesn't fit it. Free text — described in the tool schema as "a build id, a
  chat/session label, or an Epic/issue number" — covers both without inventing a structure the
  caller has to fake.
- **Recorded automatically, no new plumbing needed.** `context` is just another key in the tool's
  own `args`, and every tool call's full `args` already flows into `github_mcp_activity.params` via
  the existing `runTool()` / `recordActivity()` path (`src/tools/registry.ts`, `src/activity.ts`) —
  so it's visible in `get_recent_activity` for every write with zero schema/table changes.
- **Visible on GitHub itself — the issue's other open question, also a real call:** applied to
  *every* real comment body this server writes, not `post_comment` alone. `postIssueComment()`
  calls from both `post_comment` and `close_issue`'s NOT_PLANNED comment are prefixed with a
  visible `[chat: <context>]\n\n` tag (`tagCommentWithContext()` in `src/tools/args.ts`) — so the
  trail is readable directly on the issue, not only in the local audit log.
  `create_issue`/`update_issue`, the sub-issue/`blocked_by` tools, and `move_to_status`
  deliberately do **not** get a visible tag: an issue's own `body` isn't a comment, and a board
  move has no text field at all to embed one into — for those, `context` is traceable only through
  `get_recent_activity`, which is the issue body's own observation about why this doesn't apply
  uniformly.
- **Real verification (2026-09-10):** a `post_comment` call with `context` omitted was rejected
  with `context is required...` before any GitHub request fired; the same call with
  `context: "build-2207"` succeeded and posted
  [a real comment on #3538 itself](https://github.com/shanemccaw/Shane-McCaw-MSP/issues/3538)
  carrying the visible `[chat: build-2207]` tag — that comment doubles as this decision record.

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
