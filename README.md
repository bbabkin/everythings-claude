# Everythings for Claude Code

[Everythings](https://everythings.app) is a collaborative workspace app for
notes, lists, and items ("things"). This plugin gives Claude Code two powers:

- **MCP tools in every project** — Claude can search, read, and (with a
  write-scoped sign-in) create and edit your things from any session. When it
  needs a decision while you are away, it can ask: the question reaches your
  phone through the Everythings app, and Claude picks up your answer on its
  next run.
- **`/things` — your live panel** — publishes a private claude.ai artifact
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
   `/things`.

Your panel is a private artifact on your claude.ai account — every user
publishes their own; nothing is shared unless you share it.

## Sign-in, credentials, and data

- The plugin holds no credentials and never asks you for one. It reads no
  environment variables, no files, and no tokens from your machine, and it has
  no hooks, scripts, or local servers.
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
claude.ai, so run `/things` once there, then keep the panel open in a browser
beside Cowork: with follow mode armed it opens each thing as the Cowork agent
writes it.

## Notes

- The panel is read-only and refreshes on a ~30 second poll (the connector
  platform's floor). It shows which things an agent wrote and any question it
  is waiting on you for, but never answers one: answer in the app, or tell the
  agent in the chat.
- Panel improvements ship with plugin updates; running `/things` after an
  update republishes the new page to your same URL.

## License

MIT (see [LICENSE](LICENSE)). The Everythings name and logo remain trademarks
of their owner; the bundled Montserrat font is used under the SIL Open Font
License.
