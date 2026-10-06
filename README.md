# Everythings for Claude Code

[Everythings](https://everythings.app) is a collaborative workspace app for
notes, lists, and items ("things"). This plugin gives Claude Code three powers:

- **MCP tools in every project** — Claude can search, read, and (with a
  write-scoped sign-in) create and edit your things from any session. When it
  needs a decision while you are away, it can ask: the question reaches your
  phone through the Everythings app, and Claude picks up your answer on its
  next run.
- **`/things`: a pane in Claude Code** that draws your workspaces and
  things beside the transcript and opens each thing as the agent writes it.
  Press a mark to add or remove your own, or leave a comment, without leaving
  the session. `/findthing <query>` searches every workspace and lists the
  hits there. It needs a Claude Code build that runs plugin hook modules
  (the terminal or the desktop Code tab).
- **`/everythings:panel` — your live panel** — publishes a private claude.ai artifact
  showing your workspaces and things, with content, marks, comments, and a
  **follow mode** that auto-opens things as an agent creates them. Ask an
  agent to plan a trip and watch the plan assemble itself.

## Install

```bash
claude plugin marketplace add bbabkin/everythings-claude
```

```bash
claude plugin install everythings@everythings-claude
```

(or interactively: `/plugin marketplace add bbabkin/everythings-claude`, then
pick **everythings** under `/plugin install`.)

## Setup

1. An account at [everythings.app](https://everythings.app) (free tier works).
2. On first MCP use, Claude Code walks you through the OAuth sign-in to
   `https://www.everythings.app/api/mcp`.
3. For the panel: in claude.ai **Settings → Connectors**, find
   **Everythings** in the connector directory and connect it (or add the same
   URL as a custom connector; keep the name **Everythings**), then run
   `/everythings:panel`.

Your panel is a private artifact on your claude.ai account — every user
publishes their own; nothing is shared unless you share it.

### The pane

Start a new Claude Code session after installing or updating, then run
`/things`. Under auto permission mode, Claude Code refuses the pane's own
calls until you allow them in `permissions.allow` of `~/.claude/settings.json`:

```json
"mcp__plugin_everythings_everythings__get_thing_view",
"mcp__plugin_everythings_everythings__get_workspace_view",
"mcp__plugin_everythings_everythings__get_workspace",
"mcp__plugin_everythings_everythings__search_things",
"mcp__plugin_everythings_everythings__add_mark",
"mcp__plugin_everythings_everythings__remove_mark",
"mcp__plugin_everythings_everythings__add_comment"
```

The first four are read-only; the last three are the marks and comments you
make from the pane. When the pane shows a note, its **Copy the rules** button
gives the names your setup uses. The full guide is at
[everythings.app/docs/agents/claude-code](https://www.everythings.app/docs/agents/claude-code#pane-setup).

## Sign-in, credentials, and data

- The plugin holds no credentials and never asks you for one. It reads no
  environment variables, no files, and no tokens from your machine, and it has
  no shell scripts or local servers.
- The `/things` pane is a hooks module (`hooks/register.tsx`) that runs
  inside Claude Code. It watches one thing: the Everythings tool calls of the
  session it runs in, so it can draw what they carried. Its own calls go to
  the same Everythings MCP server through Claude Code, on the sign-in Claude
  Code already holds. It writes only when you act: your mark when you press a
  mark, your comment when you submit one, and one prompt in your name when you
  press "Ask Claude to open it", or when `/things` or `/findthing` opens on a
  page or a search it cannot read itself (once per page or search, naming the
  page by its id, or the search by the words you typed). It keeps one flag in Claude Code's plugin
  storage (that you dismissed a permissions note), copies permission rule
  text to the clipboard when you press Copy, and makes no network requests of
  its own.
- Sign-in is OAuth 2.1 with PKCE against `https://www.everythings.app/api/mcp`.
  Claude Code runs that flow and stores the resulting token itself. For the
  panel, the claude.ai connector you connect runs its own OAuth sign-in and
  keeps its own token. The skill and the panel page never see either one.
- Your workspaces, things, marks, and comments travel only between Claude and
  `www.everythings.app`, through the MCP tools that you or Claude call. The
  panel page makes no network requests of its own: claude.ai relays its tool
  calls through your connector. It keeps one value in its browser storage, the
  id of the workspace you last opened, so it reopens there.
- Privacy policy: [everythings.app/privacy](https://www.everythings.app/privacy).
  Terms: [everythings.app/terms](https://www.everythings.app/terms).

## Using Cowork?

The MCP tools work there — a Cowork agent can research and file everything
into your workspaces. Publishing the panel needs Claude Code (CLI or web) or
claude.ai, so run `/everythings:panel` once there, then keep the panel open in a browser
beside Cowork: with follow mode armed it opens each thing as the Cowork agent
writes it.

## Notes

- Under auto permission mode Claude Code can refuse the pane's own reads and
  writes. The pane then draws from what the agent's calls already carried and
  shows a note with the exact `mcp__<server>__<tool>` allow rules to add to
  your permission settings, with a Copy button.
- A mark or comment you make from the pane is yours, and it carries the
  agent's label, because the call rides the agent's sign-in.
- The panel is read-only and refreshes on a ~30 second poll (the connector
  platform's floor). It shows which things an agent wrote and any question it
  is waiting on you for, but never answers one: answer in the app, or tell the
  agent in the chat.
- Panel improvements ship with plugin updates; running `/everythings:panel` after an
  update republishes the new page to your same URL.

## License

MIT (see [LICENSE](LICENSE)). The Everythings name and logo remain trademarks
of their owner; the bundled Montserrat font is used under the SIL Open Font
License.
