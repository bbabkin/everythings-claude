// Navigation and loading: what every screen change does to the state.
//
// The pane draws from the session cache (cache.ts), so a screen shows what
// is known at once. Then the pane makes ONE read of its own to complete it:
// get_thing_view for a thing, get_workspace_view for a grid (a second call
// only when the default workspace changed since the last visit). When that
// read fails, the cached screen stays and the status says why; nothing
// retries on its own. When Claude Code refuses it, the pane is blocked
// (blocked.ts): from then on navigation reads nothing, and only Refresh
// tries again. A press on a page a read filled whole less than 30 seconds
// ago reads nothing either. Nothing here runs on a timer: a read happens
// when someone navigates, presses Refresh or Retry, or a followed write
// resolves. Reads may overlap and finish in any order, so each takes a
// number from `load.seq` and records its answer only while it is the latest.
//
// Every write to a value the pane draws from redraws it, and a redraw that
// comes between a click's focus move and its press drops the press. So a
// read shows "Loading…" only when the person pressed Refresh or Retry, and
// its answer is written only when it changes what the pane draws.

import type {
  EverythingsBlocked,
  EverythingsCache,
  EverythingsDefaultMark,
  EverythingsLoad,
  EverythingsView,
  EverythingsWrites,
} from '../types';
import { leaveAsk, type AskTarget } from './ask';
import { block, isBlocked, showNote, unblock } from './blocked';
import { drawnOf, gridOf, isWholePage, pageOf, recordDefaultMarks, recordGrid, recordPage } from './cache';
import {
  IDLE_LOAD,
  isRecord,
  parseDefaultMarks,
  parseGridView,
  parseThingView,
  READ_TOOLS,
  readResult,
  viewKey,
  type WriteTarget,
} from './data';
import type { Ports } from './ports';
import { callEverythings, NotConnectedError, RefusedError } from './server';
import { isLive, leaveWrites } from './writes';

const LAST_WORKSPACE = 'lastWorkspaceId';
const DEFAULT_WORKSPACE = 'defaultWorkspaceId';
const UNREADABLE = 'The Everythings server sent a reply the pane cannot read.';
/** A page a read filled this recently is shown from the cache on a press, with no read. */
export const FRESH_MS = 30_000;

/** Notes that a read filled the view `key` names, now. Stamps older than FRESH_MS go. */
async function stampFresh(p: Ports, key: string): Promise<void> {
  const now = await p.now();
  await p.fresh.update(fresh => {
    const kept = Object.entries(fresh).filter(([one, at]) => one !== key && now - at < FRESH_MS);
    return Object.fromEntries([...kept, [key, now]]);
  });
}

/** A write in this session may have changed any page: none counts as fresh. */
export async function forgetFresh(p: Ports): Promise<void> {
  await p.fresh.update(fresh => (Object.keys(fresh).length === 0 ? fresh : {}));
}

/** True when the cache holds the whole view and a read filled it less than FRESH_MS ago. */
async function isFresh(p: Ports, view: EverythingsView): Promise<boolean> {
  const cache = await p.cache.read();
  const isWhole =
    view.kind === 'thing'
      ? isWholePage(cache, view.thingId)
      : view.workspaceId !== null && cache.order[view.workspaceId] !== undefined;
  if (!isWhole) return false;
  const at = (await p.fresh.read())[viewKey(view)];
  return at !== undefined && (await p.now()) - at < FRESH_MS;
}

/**
 * Writes what a read brought into the cache, unless it changes nothing that
 * `views` draw: then the pane is not redrawn for it.
 */
async function recordRead(
  p: Ports,
  views: EverythingsView[],
  record: (cache: EverythingsCache) => EverythingsCache,
): Promise<void> {
  await p.cache.update(cache => {
    const next = record(cache);
    return views.every(view => drawnOf(cache, view) === drawnOf(next, view)) ? cache : next;
  });
}

/** Everything a drawing needs, read in one go (and subscribed to). */
export type PaneSnapshot = {
  view: EverythingsView;
  cache: EverythingsCache;
  /** The latest read when it was for the view on screen; idle otherwise. */
  load: EverythingsLoad;
  isFollowing: boolean;
  /** Set while Claude Code refuses the pane's reads. */
  blocked: EverythingsBlocked | null;
  isNoteDismissed: boolean;
  /** The page the pane asked Claude to open, while that ask is pending. */
  asked: string | null;
  /** The person's own marks and comments in flight, and how the last one went. */
  writes: EverythingsWrites;
};

export async function readSnapshot(p: Ports): Promise<PaneSnapshot> {
  const view = await p.view.read();
  const cache = await p.cache.read();
  const load = await p.load.read();
  const isFollowing = await p.follow.read();
  const blocked = await p.blocked.read();
  const isNoteDismissed = await p.noteDismissed.read();
  const asked = await p.asked.read();
  const stored = await p.writes.read();
  // Markers an earlier load left (older than 30 seconds) draw as nothing in flight.
  const now = await p.now();
  const isStale = (at: number) => !isLive(at, now);
  const writes: EverythingsWrites = {
    ...stored,
    pending: Object.fromEntries(Object.entries(stored.pending).filter(([, at]) => !isStale(at))),
    commenting: Object.fromEntries(Object.entries(stored.commenting).filter(([, at]) => !isStale(at))),
    last:
      stored.last !== null && (stored.last.did === 'adding' || stored.last.did === 'removing') && isStale(stored.last.at)
        ? null
        : stored.last,
  };
  return {
    view,
    cache,
    load: load.key === viewKey(view) ? load : IDLE_LOAD,
    isFollowing,
    blocked,
    isNoteDismissed,
    asked,
    writes,
  };
}

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string | null; isNotConnected: boolean; refused: RefusedError | null };

function failed(error: string | null, isNotConnected = false): Outcome<never> {
  return { ok: false, error, isNotConnected, refused: null };
}

async function fetchView<T>(
  p: Ports,
  tool: string,
  args: Record<string, unknown>,
  shape: (data: unknown) => T | null,
): Promise<Outcome<T>> {
  try {
    const answer = readResult(await callEverythings(p, tool, args));
    if ('error' in answer) return failed(answer.error);
    const value = shape(answer.data);
    return value ? { ok: true, value } : failed(UNREADABLE);
  } catch (error) {
    if (error instanceof NotConnectedError) return failed(null, true);
    // A refusal is no failure to show: the pane is blocked instead (endLoad).
    if (error instanceof RefusedError) return { ok: false, error: null, isNotConnected: false, refused: error };
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Starts a read for the view `key` names; answers the read's number.
 * `isShown`: the read shows as "Loading…" (Refresh and Retry).
 */
async function startLoad(p: Ports, key: string, isShown: boolean): Promise<number> {
  const load = await p.load.update(last => ({
    seq: last.seq + 1,
    key,
    isLoading: isShown,
    error: null,
    isNotConnected: false,
  }));
  return load.seq;
}

/** False once a later read has started: this one's answer is stale. */
async function isLatest(p: Ports, seq: number): Promise<boolean> {
  return (await p.load.read()).seq === seq;
}

function isRefused(outcome: Outcome<unknown>): boolean {
  return !outcome.ok && outcome.refused !== null;
}

/** Records how a read ended. A success ends blocked mode; a refusal starts it, or keeps it quietly. */
async function endLoad(p: Ports, seq: number, outcome: Outcome<unknown>): Promise<void> {
  if (outcome.ok) await unblock(p);
  else if (outcome.refused !== null) await block(p, outcome.refused);
  await p.load.update(load =>
    load.seq !== seq
      ? load
      : outcome.ok
        ? { ...load, isLoading: false, error: null, isNotConnected: false }
        : { ...load, isLoading: false, error: outcome.error, isNotConnected: outcome.isNotConnected },
  );
}

async function storedId(p: Ports, key: string): Promise<string | null> {
  const value = await p.storeGet(key);
  return typeof value === 'string' && value ? value : null;
}

/**
 * Reads the grid of `workspaceId`. With none named the pane lands on the
 * default workspace, else the last one opened, else the first. It asks for
 * the landing those rules gave last time, so a steady account costs one
 * read; a second read happens only when the default changed meanwhile.
 */
async function loadGrid(p: Ports, workspaceId: string | null, isShown: boolean): Promise<boolean> {
  const seq = await startLoad(p, viewKey({ kind: 'grid', workspaceId }), isShown);
  const since = (await p.cache.read()).tick;

  const last = await storedId(p, LAST_WORKSPACE);
  const preferred = workspaceId ?? (await storedId(p, DEFAULT_WORKSPACE)) ?? last;
  let outcome = await fetchView(p, READ_TOOLS.grid, preferred ? { workspaceId: preferred } : {}, parseGridView);

  if (outcome.ok && workspaceId === null && outcome.value.landing) {
    const grid = outcome.value;
    const lastIsLive = last !== null && grid.workspaces.some(ws => ws.id === last);
    const wanted = grid.defaultWorkspaceId ?? (lastIsLive ? last : null) ?? grid.workspaces[0]?.id ?? null;
    if (wanted && wanted !== grid.landing?.workspaceId) {
      const corrected = await fetchView(p, READ_TOOLS.grid, { workspaceId: wanted }, parseGridView);
      if (corrected.ok) outcome = corrected;
    }
  }

  if (outcome.ok && (await isLatest(p, seq))) {
    const grid = outcome.value;
    const landed = grid.landing?.workspaceId ?? null;
    const views: EverythingsView[] = [
      { kind: 'grid', workspaceId },
      { kind: 'grid', workspaceId: landed },
    ];
    await recordRead(p, views, cache => recordGrid(cache, grid, since, null));
    await p.view.update(view =>
      view.kind === 'grid' && view.workspaceId === workspaceId ? { kind: 'grid', workspaceId: landed } : view,
    );
    if (landed) await stampFresh(p, viewKey({ kind: 'grid', workspaceId: landed }));
    await p.storeSet(DEFAULT_WORKSPACE, grid.defaultWorkspaceId);
    if (landed) await p.storeSet(LAST_WORKSPACE, landed);
  }
  await endLoad(p, seq, outcome);
  return isRefused(outcome);
}

/**
 * The workspace's default marks, read once per workspace per session when a
 * thing page opens and they are unknown. A failure or a refusal leaves them
 * unknown: the page then offers only the marks the thing carries. A refusal
 * of this read alone blocks nothing, so a person who allowed only the page
 * reads keeps them.
 */
async function fetchDefaults(p: Ports, workspaceId: string | null): Promise<DefaultMarks | null> {
  if (workspaceId === null || (await p.cache.read()).defaultMarks[workspaceId] !== undefined) return null;
  let isFirst = false;
  await p.defaultsAsked.update(asked => {
    isFirst = !asked.includes(workspaceId);
    return isFirst ? [...asked, workspaceId].slice(-50) : asked;
  });
  if (!isFirst) return null;
  const outcome = await fetchView(p, READ_TOOLS.defaults, { workspaceId }, parseDefaultMarks);
  return outcome.ok ? { workspaceId, marks: outcome.value } : null;
}

type DefaultMarks = { workspaceId: string; marks: EverythingsDefaultMark[] };

async function loadThing(p: Ports, thingId: string, isShown: boolean): Promise<boolean> {
  const seq = await startLoad(p, viewKey({ kind: 'thing', thingId, workspaceId: null }), isShown);
  const since = (await p.cache.read()).tick;
  // The defaults first, so the page and its marks go into the cache in one write.
  const defaults = await fetchDefaults(p, (await p.cache.read()).things[thingId]?.workspaceId ?? null);
  const outcome = await fetchView(p, READ_TOOLS.thing, { thingId }, parseThingView);
  if (defaults !== null && !(outcome.ok && (await isLatest(p, seq)))) {
    await p.cache.update(cache => recordDefaultMarks(cache, defaults.workspaceId, defaults.marks));
  }
  if (outcome.ok && (await isLatest(p, seq))) {
    const page = outcome.value;
    await recordRead(p, [{ kind: 'thing', thingId, workspaceId: null }], cache => {
      const read = recordPage(cache, page, since, thingId);
      return defaults === null ? read : recordDefaultMarks(read, defaults.workspaceId, defaults.marks);
    });
    const workspaceId = page.workspace?.id ?? page.thing.workspaceId ?? null;
    if (workspaceId) {
      await p.view.update(view =>
        view.kind === 'thing' && view.thingId === thingId ? { ...view, workspaceId } : view,
      );
    }
    await stampFresh(p, viewKey({ kind: 'thing', thingId, workspaceId: null }));
  }
  await endLoad(p, seq, outcome);
  return isRefused(outcome);
}

/** The workspace a thing view starts under, before its read says. */
async function workspaceOf(p: Ports, thingId: string): Promise<string | null> {
  const known = (await p.cache.read()).things[thingId]?.workspaceId;
  return known ?? (await p.view.read()).workspaceId;
}

/**
 * Puts `view` on screen. An ask pending for another page goes. While the
 * pane is blocked the cache alone draws it, and a failure an earlier read
 * left for it goes too, so no error line or Retry shows.
 */
async function show(p: Ports, view: EverythingsView): Promise<void> {
  await p.view.update(() => view);
  await leaveAsk(p);
  await leaveWrites(p);
  if (await isBlocked(p)) {
    const key = viewKey(view);
    await p.load.update(load =>
      load.key === key && (load.error !== null || load.isNotConnected)
        ? { ...load, error: null, isNotConnected: false }
        : load,
    );
  }
}

/**
 * Shows the grid of `workspaceId` (null: the landing rules) and reads it,
 * unless blocked, or unless `mayReuse` and a read filled it moments ago.
 */
export async function openGrid(p: Ports, workspaceId: string | null, mayReuse = false): Promise<void> {
  const view: EverythingsView = { kind: 'grid', workspaceId };
  await show(p, view);
  if (await isBlocked(p)) return;
  if (mayReuse && (await isFresh(p, view))) return;
  await loadGrid(p, workspaceId, false);
}

/**
 * Shows one thing (what the cache knows of it at once) and reads it, unless
 * blocked, or unless `mayReuse` and a read filled it moments ago.
 */
export async function openThing(p: Ports, thingId: string, mayReuse = false): Promise<void> {
  const workspaceId = await workspaceOf(p, thingId);
  const view: EverythingsView = { kind: 'thing', thingId, workspaceId };
  await show(p, view);
  if (await isBlocked(p)) return;
  if (mayReuse && (await isFresh(p, view))) return;
  await loadThing(p, thingId, false);
}

/**
 * Reads the view on screen; what it shows stays drawn meanwhile. `isShown`:
 * the read shows as "Loading…". Answers whether Claude Code refused it.
 */
async function readView(p: Ports, isShown: boolean): Promise<boolean> {
  const view = await p.view.read();
  return view.kind === 'grid' ? loadGrid(p, view.workspaceId, isShown) : loadThing(p, view.thingId, isShown);
}

/** Reads the view on screen again, unless blocked (/things and follow). */
export async function refreshView(p: Ports): Promise<void> {
  if (!(await isBlocked(p))) await readView(p, false);
}

/**
 * The page to ask Claude for when the pane will not fill the screen by
 * itself (no server answered, Claude Code refuses its reads, or the read
 * failed) and the cache has nothing to draw there. Null when the screen
 * draws something, or a read may still fill it.
 */
export async function unfilledPage(p: Ports): Promise<AskTarget | null> {
  const { view, cache, load, blocked } = await readSnapshot(p);
  if (blocked === null && load.error === null && !load.isNotConnected) return null;
  if (view.kind === 'thing') {
    return pageOf(cache, view.thingId) === null ? { kind: 'thing', id: view.thingId } : null;
  }
  const landing = gridOf(cache, view.workspaceId).landing;
  if (landing !== null && (landing.things.length > 0 || landing.isListed)) return null;
  return { kind: 'workspace', id: landing?.workspaceId ?? null };
}

/**
 * Refresh and Retry: one read, blocked or not, however fresh the page. The
 * one way out of blocked mode. The person asked for this read, so a refusal
 * shows the note again, even after Dismiss, to say why nothing changed.
 */
export async function pressRefresh(p: Ports): Promise<void> {
  if (await readView(p, true)) await showNote(p);
}

/**
 * The person's presses on a thing, a workspace or back: each pauses follow,
 * so the next write leaves the pane be, and a page a read filled moments ago
 * shows with no read. Refresh and Retry leave follow as it is.
 */
export async function pressThing(p: Ports, thingId: string): Promise<void> {
  await p.follow.update(() => false);
  await openThing(p, thingId, true);
}

export async function pressWorkspace(p: Ports, workspaceId: string): Promise<void> {
  await p.follow.update(() => false);
  await openGrid(p, workspaceId, true);
}

/** From a thing back to its workspace's grid. */
export async function pressBack(p: Ports): Promise<void> {
  await p.follow.update(() => false);
  await openGrid(p, (await p.view.read()).workspaceId, true);
}

export async function toggleFollow(p: Ports): Promise<void> {
  await p.follow.update(isFollowing => !isFollowing);
}

/** Opening the pane arms follow again. */
export async function resumeFollow(p: Ports): Promise<void> {
  await p.follow.update(() => true);
}

/**
 * Points the pane at what a write touched, when follow is on: the thing it
 * wrote. A delete of the thing on screen goes back to its grid; a delete of
 * anything else leaves the view where it is, to be read again (a deleted
 * sub-thing leaves its parent's list). Answers whether a read is worth making
 * now: only while the pane is open (a closed one reads when it opens).
 */
export async function followWrite(p: Ports, target: WriteTarget): Promise<boolean> {
  if (!(await p.follow.read())) return false;
  const view = await p.view.read();
  if (target.kind === 'deleted') {
    await p.view.update(shown =>
      shown.kind === 'thing' && shown.thingId === target.thingId
        ? { kind: 'grid', workspaceId: shown.workspaceId }
        : shown,
    );
    await leaveAsk(p);
  } else if (view.kind !== 'thing' || view.thingId !== target.thingId) {
    const workspaceId = await workspaceOf(p, target.thingId);
    await show(p, { kind: 'thing', thingId: target.thingId, workspaceId });
  }
  return p.isPaneOpen();
}

/**
 * The agent read the page on screen itself (get_thing_view, or
 * get_workspace_view of the grid on screen): the screen is complete, so a
 * failure line left by the pane's own read goes.
 */
export async function agentCompletedView(
  p: Ports,
  name: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
): Promise<void> {
  const view = await p.view.read();
  let isComplete = false;
  if (name === READ_TOOLS.thing) {
    isComplete = view.kind === 'thing' && args.thingId === view.thingId;
  } else if (name === READ_TOOLS.grid && data && isRecord(data.landing)) {
    isComplete = view.kind === 'grid' && (view.workspaceId === null || data.landing.workspaceId === view.workspaceId);
  }
  if (!isComplete) return;
  const key = viewKey(view);
  await p.load.update(load =>
    load.key === key && !load.isLoading ? { ...load, error: null, isNotConnected: false } : load,
  );
}
