---
name: things
description: Open or update the user's Everythings Panel — a live claude.ai artifact showing their workspaces, things, marks, and comments, with a follow mode that opens things as an agent creates them. Invoked as /things. Use when the user asks to open, show, update, or refresh "the panel", "my Everythings panel", or "/things".
---

# Everythings Panel — open it for this user

The panel is a private claude.ai Artifact that reads the viewer's Everythings
data through their claude.ai **Everythings** connector (`window.claude.mcp`).
The page ships with this plugin at `assets/panel.html` (relative to this
skill's base directory), fully self-contained. Each user publishes their own
copy; a connector-declaring artifact cannot be shared by URL.

## Procedure

1. **Load the `artifact-capabilities` skill first** — it carries the runtime
   contract and this user's capability roster. If `mcp` is not in their
   available capabilities, stop and say the panel needs artifact connector
   access, which their account does not have yet.
2. **Find their existing panel**: call Artifact with `action: "list"` and look
   for an artifact titled **Everythings Panel** owned by the user.
   - Found → publish `assets/panel.html` with `url` set to that artifact's
     URL. This updates their panel in place (do this for "open" as well as
     "update"; same result, same address).
   - Not found → publish `assets/panel.html` fresh with the capabilities
     manifest below. Their panel gets its own private URL; later sessions find
     it via the listing.
3. **Favicon is always 🗂️** — identical on every publish.
4. **Capabilities manifest** (pass explicitly on a first publish and whenever
   the bundled manifest changes; omitting `capabilities` on a routine
   republish carries the stored grant forward):

   ```json
   {"mcp": {"servers": [{"server": "Everythings", "tools": [
     "bootstrap", "list_workspaces", "list_things", "list_child_things",
     "get_thing", "list_comments", "list_marks", "recent_things"]}]}}
   ```

5. Give the user the artifact link. That is the whole job.

## Surfaces without the Artifact tool (Cowork desktop today)

If this session has no Artifact tool, the panel cannot be published or
updated from here — do not improvise a substitute page or fork the bundled
one. Tell the user, in this order:

1. The panel publishes from **Claude Code** (CLI or web) or claude.ai — run
   `/things` there once; the connector-setup pointer above applies there too.
2. An **already-published panel keeps working**: opened in any browser at its
   claude.ai URL with follow mode armed, it jumps to things as they are
   created — including things this very session writes through the
   Everythings MCP tools. Publishing surface and watching surface are
   independent.

The MCP tools themselves work normally on every surface; only the publish
step needs the Artifact tool.

## Never open it in a browser

Publishing with the Artifact tool IS opening the panel — it renders in the
claude.ai side panel. Never point a browser pane, Chrome, or any external
browser at the artifact URL or at everythings.app on the panel's behalf: the
page needs the viewer's claude.ai session and connector bridge, and anywhere
else it shows only its "Open this page from claude.ai" banner.

## If the connector is missing

The page banners "Everythings isn't connected" when the viewer has no
Everythings connector. Walk them through it: claude.ai **Settings →
Connectors**, find **Everythings** in the connector directory and click
Connect (fallback for builds without the directory: **Add custom connector**
with URL `https://www.everythings.app/api/mcp`). Sign-in happens in the
browser; keep the display name **Everythings**. Then reload the panel.

## Do not modify the bundled page

`assets/panel.html` is a built artifact of the Everythings project; panel
fixes and features arrive with plugin updates. Do not edit it, restyle it, or
regenerate its inlined assets here — republishing the bundled file to the
user's existing URL is the only update path. If the user wants a change to
the panel itself, that is feedback for the Everythings project, and this
skill's job is only to note it, never to fork the page.

## What the panel does (for answering questions)

- Opens on the user's default workspace, painting in one round trip via the
  server's `bootstrap` tool (falls back to per-list calls on older servers or
  when a grant lags; degraded states are built in).
- Tiles match the app's visual language; clicking a thing shows its Markdown
  content, sub-things, marks, and comments. Data refreshes on a ~30 s poll —
  the connector contract's floor, so "live" means within half a minute.
- The radar toggle arms **follow mode**: any thing created or updated after
  arming opens automatically (workspace switch and breadcrumbs included) — the
  way to watch an agent build things in real time. When the agent keeps
  writing into the thing already open, its text updates in place instead of
  re-opening, landing in ~15 s on average. Manual navigation pauses follow; it
  is off on every load.
- Read-only today: marks and comments display, but writing them stays in the
  app.
