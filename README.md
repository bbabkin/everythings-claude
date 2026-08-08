# Everythings for Claude Code

[Everythings](https://everythings.app) is a collaborative workspace app for
notes, lists, and items ("things"). This plugin gives Claude Code two powers:

- **MCP tools in every project** — Claude can search, read, and (with a
  write-scoped sign-in) create and edit your things from any session.
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
3. For the panel: add the same URL as a custom connector in claude.ai
   **Settings → Connectors** (keep the name **Everythings**), then run
   `/things`.

Your panel is a private artifact on your claude.ai account — every user
publishes their own; nothing is shared unless you share it.

## Notes

- The panel is read-only and refreshes on a ~30 second poll (the connector
  platform's floor).
- Panel improvements ship with plugin updates; running `/things` after an
  update republishes the new page to your same URL.
