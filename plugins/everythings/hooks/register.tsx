// The everythings mod: Everythings in a pane beside the transcript.
//
// This file is the engine boundary. The engine follows `$` only into
// functions declared in the file whose hook received it, so every hook lives
// here, and `ports($)` below is the one place the mod spells out `$.mcp`,
// `$.store`, `$.ui`, `$.prompt`, `$.clock` and `$.state`. The logic is in the
// other files, written against Ports: nav.ts (screens and reads), cache.ts
// (what the session's calls carried), server.ts (which MCP server),
// blocked.ts (when Claude Code refuses the pane's calls), ask.ts (asking
// Claude to open a page or run a search), writes.ts (the person's own mark
// and comment, the pane's only writes), follow.ts (push follow),
// inbox.ts (the band above the prompt, and the wake on an answer),
// showThing.ts (the tool), pane.tsx (the drawing), rows.tsx (the
// transcript's rows of Everythings writes), data.ts (payloads). A
// new feature is a file of that kind plus its hook here; the state it reads
// is declared in ../types/index.d.ts.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';

import { askClaude } from './ask';
import { EMPTY_CACHE } from './cache';
import { IDLE_INBOX, IDLE_LOAD, IDLE_WAKE, IDLE_WRITES, INITIAL_VIEW, PANE_ID, PANE_TITLE } from './data';
import { observeCall } from './follow';
import { isWaiting, pollAnswers, refreshInbox, WAKE_POLL_MS, watchAsk } from './inbox';
import { pressInbox, readSnapshot, refreshView, resumeFollow, runSearch, unfilledPage } from './nav';
import { drawBand, drawPane, paneActions } from './pane';
import { cellOf, type Ports } from './ports';
import { drawRow, judgeRow, writeRow } from './rows';
import { SHOW_THING, showThing } from './showThing';

const viewAtom = atom({ plugin: 'everythings', key: 'view' } as const, INITIAL_VIEW);
// Shaped: after a hot reload that changes the cache's shape, bump the tag
// and the old value reads as absent instead of drawing in the old shape.
const cacheAtom = atom({ plugin: 'everythings', key: 'cache' } as const, EMPTY_CACHE, { shape: 'v3' });
const loadAtom = atom({ plugin: 'everythings', key: 'load' } as const, IDLE_LOAD);
const followAtom = atom({ plugin: 'everythings', key: 'follow' } as const, true);
const serverAtom = atom({ plugin: 'everythings', key: 'server' } as const, null);
const blockedAtom = atom({ plugin: 'everythings', key: 'blocked' } as const, null);
const noteDismissedAtom = atom({ plugin: 'everythings', key: 'noteDismissed' } as const, false);
const askedAtom = atom({ plugin: 'everythings', key: 'asked' } as const, null);
const freshAtom = atom({ plugin: 'everythings', key: 'fresh' } as const, {});
const defaultsAskedAtom = atom({ plugin: 'everythings', key: 'defaultsAsked' } as const, []);
const writesAtom = atom({ plugin: 'everythings', key: 'writes' } as const, IDLE_WRITES, { shape: 'v2' });
const inboxAtom = atom({ plugin: 'everythings', key: 'inbox' } as const, IDLE_INBOX);
const wakeAtom = atom({ plugin: 'everythings', key: 'wake' } as const, IDLE_WAKE);

/** The engine, as the logic files may use it. A write that changes nothing is skipped (cellOf). */
function ports($: EngineInterface): Ports {
  return {
    view: cellOf(
      () => read($, viewAtom),
      change => update($, viewAtom, change),
    ),
    // The cache is large and every record makes a new one, so only the same value counts as equal.
    cache: cellOf(
      () => read($, cacheAtom),
      change => update($, cacheAtom, change),
      Object.is,
    ),
    load: cellOf(
      () => read($, loadAtom),
      change => update($, loadAtom, change),
    ),
    follow: cellOf(
      () => read($, followAtom),
      change => update($, followAtom, change),
    ),
    server: cellOf(
      () => read($, serverAtom),
      change => update($, serverAtom, change),
    ),
    blocked: cellOf(
      () => read($, blockedAtom),
      change => update($, blockedAtom, change),
    ),
    noteDismissed: cellOf(
      () => read($, noteDismissedAtom),
      change => update($, noteDismissedAtom, change),
    ),
    asked: cellOf(
      () => read($, askedAtom),
      change => update($, askedAtom, change),
    ),
    fresh: cellOf(
      () => read($, freshAtom),
      change => update($, freshAtom, change),
    ),
    defaultsAsked: cellOf(
      () => read($, defaultsAskedAtom),
      change => update($, defaultsAskedAtom, change),
    ),
    writes: cellOf(
      () => read($, writesAtom),
      change => update($, writesAtom, change),
    ),
    inbox: cellOf(
      () => read($, inboxAtom),
      change => update($, inboxAtom, change),
    ),
    wake: cellOf(
      () => read($, wakeAtom),
      change => update($, wakeAtom, change),
    ),
    now: () => $.clock.now(),
    mcpCall: (server, tool, args) => $.mcp.call(server, tool, args),
    mcpConnect: async server => {
      const answer = await $.mcp.connect(server);
      return answer.isConnected
        ? { isConnected: true, server: answer.server }
        : { isConnected: false, message: answer.message };
    },
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    openPane: async () => void (await $.ui.open({ id: PANE_ID, title: PANE_TITLE })),
    isPaneOpen: async () => (await $.ui.panes()).some(pane => pane.id === PANE_ID),
    askClaude: async text => (await $.prompt.submit({ text, asUser: true })).drop === undefined,
    wakeSession: async text => void (await $.prompt.submit({ text })),
    copy: async (text, surface) => (await $.ui.copy({ text, surface })).isCopied,
  };
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'things',
      description: 'Open the Everythings pane: your workspaces and things, following what the agent writes',
    });
    await $.command.register({
      name: 'findthing',
      description: 'Search your Everythings things in every workspace and list them in the pane',
      argumentHint: '<query>',
    });
    await $.tool.register(SHOW_THING);
    const started = await next(e);
    // The band's counts, read once the session is up, on the server an earlier session learned; left running.
    const p = ports($);
    void refreshInbox(p).catch(() => undefined);
    // After a hot reload the poll's timer is gone; a question still waited on starts it again.
    if (await isWaiting(p)) startPoll($);
    return started;
  });

  // `/things` opens the pane on the view it last showed, arms follow,
  // and reads that view again. A screen that read leaves empty asks Claude
  // for the page, so the pane never opens on a blank or an error alone:
  // Claude's own calls reach the connector under whatever name it runs, and
  // teach the pane its server. The engine refuses a prompt submitted from
  // this hook (it would wait on the turn the hook holds), so the ask goes
  // out from a one-shot `$.clock.after` once the command has returned, and
  // only if the screen is still empty then.
  on('command.run', { command: 'things' }, async $ => {
    const p = ports($);
    await p.openPane();
    await resumeFollow(p);
    await refreshView(p);
    if ((await unfilledPage(p)) !== null) $.clock.after(ASK_MS, () => void askIfUnfilled($));
    return {};
  });

  // `/findthing <query>` opens the pane on the search's hits, from one
  // search_things call of the pane's own, and pauses follow. A search the
  // pane could not run (refused, failed, or its reads blocked) is asked of
  // Claude once, the way `/things` asks for an empty page: from a one-shot
  // `$.clock.after` once the command has returned. The agent's own
  // search_things answer then fills the list through the follow hook.
  on('command.run', { command: 'findthing' }, async ($, e) => {
    const p = ports($);
    await p.openPane();
    await runSearch(p, e.args);
    if ((await unfilledPage(p)) !== null) $.clock.after(ASK_MS, () => void askIfUnfilled($));
    return {};
  });

  // The model's `mcp__everythings__show_thing`.
  on('tool.call', { tool: 'mcp__everythings__show_thing' }, async ($, e) => ({
    result: await showThing(ports($), e as unknown as Record<string, unknown>),
  }));

  // Push follow and the session cache. The matcher admits the tools in
  // UNIQUE_TOOLS and the followed, recorded or writing ones of GENERIC_TOOLS
  // (data.ts), on any server, so no other call (Bash, Read, another server's
  // tools) reaches the plugin. The call goes on as it came and its result
  // comes back as it was; nothing that follow does may change or break it.
  on(
    'tool.call',
    {
      tool: /^mcp__.+__(?:what_changed|my_reception|search_things|get_thing|get_thing_view|get_workspace_view|list_things|list_child_things|recent_things|create_thing|update_thing|delete_thing|restore_thing|move_thing|reorder_things|copy_thing|claim_thing|release_thing|request_input|answer_request|resolve_request|list_requests|list_mentions|add_comment|add_mark|remove_mark|resolve_mention|list_workspaces|get_workspace|list_comments|list_marks|create_workspace|rename_workspace)$/,
    },
    async ($, e, next) => {
      const ran = await next(e);
      try {
        await observeCall(ports($), e.tool, e as unknown as Record<string, unknown>, ran);
      } catch {
        // Follow is a convenience; the call's own result is what matters.
      }
      try {
        // The session's own question: the wake poll waits on it.
        if (await watchAsk(ports($), e.tool, ran)) startPoll($);
      } catch {
        // The question goes unwatched; the person's answer still reaches the agent's next run.
      }
      return ran;
    },
  );

  // Transcript rows: a resolved Everythings write reads as one compact row
  // ("updated 🍋 Lemon cake", the name a Link to the thing in the app), and
  // the result block under it draws nothing (rows.tsx). The matchers admit
  // the write tools of ROW_VERBS alone, on any server; rows.tsx then tells
  // an Everythings server as follow does. An errored, running or
  // interrupted call, or one rows.tsx cannot judge, keeps the engine's row.
  on(
    'ui.render',
    {
      component: 'ToolUse',
      props: {
        tool: /^mcp__.+__(?:create_thing|update_thing|move_thing|delete_thing|restore_thing|copy_thing|add_mark|remove_mark|add_comment|request_input)$/,
      },
    },
    async ($, e, next) => {
      try {
        const row = await writeRow(ports($), e.props);
        if (row) return drawRow($.ui.resolve(e), row);
      } catch {
        // A row the mod cannot draw is the engine's.
      }
      return next(e);
    },
  );
  on(
    'ui.render',
    {
      component: 'ToolResult',
      props: {
        tool: /^mcp__.+__(?:create_thing|update_thing|move_thing|delete_thing|restore_thing|copy_thing|add_mark|remove_mark|add_comment|request_input)$/,
      },
    },
    async ($, e, next) => {
      try {
        if (await judgeRow(ports($), e.props.tool, e.props.isErrored, e.props.output)) {
          const { Box } = $.ui.resolve(e);
          return <Box />;
        }
      } catch {
        // The engine's own result block.
      }
      return next(e);
    },
  );

  // The band above the prompt: the open questions and @Agent jobs, a Button
  // each, hidden at zero (inbox.ts). A press opens the pane on that list. A
  // survey holds the band, and the mod yields it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    try {
      const p = ports($);
      const band = drawBand($.ui.resolve(e), await p.inbox.read(), {
        open: list => void pressInbox(p, list).catch(() => undefined),
      });
      if (band !== null) return band;
    } catch {
      // The band is the engine's.
    }
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: 'everythings' }, async ($, e) => {
    const p = ports($);
    return drawPane($.ui.resolve(e), e.surface, await readSnapshot(p), paneActions(p));
  });

  // After a press, a submitted comment or a picked workspace in the pane,
  // the pane asks for the keyboard back, once. The element acted on leaves
  // the redrawn tree (a posted comment's field comes back under a new key)
  // and the pane loses the keyboard with it (seen live 2026-10-03 in the
  // desktop app), so the next click only took focus and pressed nothing.
  // A one-shot `$.clock.after`, started by the
  // person's act and replaced by the next one; it runs once. Nothing asks
  // again later: a second ask that fell between a click's focus and its
  // press was seen to swallow the press. The phone has no keyboard to give,
  // and a closed pane is left closed.
  on('ui.press', { plugin: 'everythings', component: 'Pane', requestId: 'everythings' }, async ($, e, next) => {
    const pressed = await next(e);
    if (e.surface !== 'mobile') refocusSoon($);
    return pressed;
  });
  on('ui.input', { plugin: 'everythings', component: 'Pane', requestId: 'everythings' }, async ($, e, next) => {
    const typed = await next(e);
    if (e.kind === 'submit' && e.surface !== 'mobile') refocusSoon($);
    return typed;
  });
  on('ui.select', { plugin: 'everythings', component: 'Pane', requestId: 'everythings' }, async ($, e, next) => {
    const picked = await next(e);
    if (e.surface !== 'mobile') refocusSoon($);
    return picked;
  });
};

/** How long after `/things` or `/findthing` returns an empty pane asks Claude for its page. */
const ASK_MS = 100;

/** Asks Claude for the page on screen when nothing draws there; once per page (ask.ts). */
async function askIfUnfilled($: EngineInterface): Promise<void> {
  try {
    const p = ports($);
    const target = await unfilledPage(p);
    if (target !== null) await askClaude(p, target);
  } catch {
    // The pane keeps its notice and the ask Button.
  }
}

/**
 * The wake poll: the mod's one repeating timer. It runs while a question
 * this session asked is waited on, every WAKE_POLL_MS, and stops itself when
 * none is left (answered, past its two hours, or a refused poll). A period
 * that comes while the last still runs does nothing.
 */
let poll: Timer | null = null;
let isPolling = false;

function startPoll($: EngineInterface): void {
  if (poll !== null) return;
  poll = $.clock.every(WAKE_POLL_MS, () => void pollOnce($));
}

async function pollOnce($: EngineInterface): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  let goesOn = true;
  try {
    goesOn = await pollAnswers(ports($));
  } catch {
    // The next period asks again.
  } finally {
    isPolling = false;
  }
  if (!goesOn) {
    poll?.cancel();
    poll = null;
    // A question asked while this period ran starts the poll again.
    if (await isWaiting(ports($)).catch(() => false)) startPoll($);
  }
}

/** How long after a press the pane asks for the keyboard back. */
const REFOCUS_MS = 200;
/** The refocus an act started and that has not run yet; a later act replaces it. */
let pendingRefocus: Timer | null = null;

/** Asks for the keyboard back REFOCUS_MS from now, in place of an ask still pending. */
function refocusSoon($: EngineInterface): void {
  pendingRefocus?.cancel();
  pendingRefocus = $.clock.after(REFOCUS_MS, () => {
    pendingRefocus = null;
    void refocusPane($);
  });
}

/** Asks for the keyboard for the open pane, unless it holds it. A refusal (text in the composer, a dialog) is silent. */
async function refocusPane($: EngineInterface): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE_ID);
    if (!pane || pane.isFocused) return;
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true });
  } catch {
    // The pane goes on without the keyboard.
  }
}
