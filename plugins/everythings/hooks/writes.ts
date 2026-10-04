// The person's own writes from the pane: their mark on a press, their
// comment on a submit. The pane writes nothing else: no answer to an
// agent's question (it would ride the agent's token and read as the agent
// answering itself), no content, no reply.
//
// Each write is one `$.mcp.call` on the learned server (server.ts), never
// retried. While it is in flight its Button or field cannot send again; the
// marker is cleared however the call ends, and one older than 30 seconds
// (left by an earlier load) blocks nothing. A plugin's `$.mcp.call` raises
// the `mcp.call` event, which follow does not hook, so nothing follows these
// calls. On success the answer goes through recordCall, the same code that
// records the agent's own add_mark, remove_mark and add_comment, so the
// count, `mine` and the comment list stay true with no read. An `isError`
// answer or a rejection changes nothing and leaves one line with the
// server's text. A refusal by Claude Code leaves a line where the person
// pressed and a note with the rules that let that write through.

import type { EverythingsWrites } from '../types';
import { rulesFor } from './blocked';
import { PERSON_AUTHOR, recordCall } from './cache';
import { COMMENT_LIMIT, readResult, WRITE_STALE_MS, WRITE_TOOLS } from './data';
import type { Ports } from './ports';
import { callLearnedServer, NotConnectedError, RefusedError } from './server';

export const NOT_REACHED = 'The pane has not reached Everythings yet in this session. Press Refresh first.';
export const TOO_LONG = `A comment holds at most ${COMMENT_LIMIT.toLocaleString('en-US')} characters.`;
/** Said where the person pressed when Claude Code refused the write. */
export const WRITE_REFUSED: Record<'mark' | 'comment', string> = {
  mark: "Claude Code's permission mode blocked the mark.",
  comment: "Claude Code's permission mode blocked the comment.",
};
/** At most this many things keep a count of comments posted from the pane. */
const POSTED_KEPT = 300;

/** A mark Button: a mark the thing carries, or a default mark it does not. */
export type MarkPress = { name: string; emoji: string };

type Written =
  | { ok: true; data: Record<string, unknown> | null }
  | { ok: false; text: string | null; refused: RefusedError | null };

async function write(p: Ports, tool: string, args: Record<string, unknown>): Promise<Written> {
  try {
    const answer = readResult(await callLearnedServer(p, tool, args));
    return 'error' in answer ? { ok: false, text: answer.error, refused: null } : { ok: true, data: answer.data };
  } catch (error) {
    if (error instanceof RefusedError) return { ok: false, text: null, refused: error };
    if (error instanceof NotConnectedError) return { ok: false, text: NOT_REACHED, refused: null };
    return { ok: false, text: error instanceof Error ? error.message : String(error), refused: null };
  }
}

/** Records a write that went through, as recordCall records the agent's. */
async function recordWrite(
  p: Ports,
  tool: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
  author?: string,
): Promise<void> {
  const view = await p.view.read();
  const pinned = view.kind === 'thing' ? view.thingId : null;
  await p.cache.update(cache => recordCall(cache, tool, args, data ?? { action: 'unchanged' }, pinned, author));
}

/** True while a marker stamped `at` still counts at `now`. */
export function isLive(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < WRITE_STALE_MS;
}

/** The markers that still count. */
function live(markers: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(markers).filter(([, at]) => isLive(at, now)));
}

function without(markers: Record<string, number>, key: string): Record<string, number> {
  const { [key]: _gone, ...rest } = markers;
  return rest;
}

/** How a write ended, written back: an error or refusal line, the note, or a note cleared by a write that went through. */
function settled(
  writes: EverythingsWrites,
  thingId: string,
  on: 'mark' | 'comment',
  written: Written | null,
): Pick<EverythingsWrites, 'error' | 'blocked'> {
  if (written === null) return { error: writes.error, blocked: writes.blocked };
  if (written.ok) return { error: writes.error, blocked: writes.blocked?.on === on ? null : writes.blocked };
  if (written.refused !== null) {
    const tools = on === 'mark' ? [WRITE_TOOLS.addMark, WRITE_TOOLS.removeMark] : [WRITE_TOOLS.comment];
    return {
      error: { thingId, on, text: WRITE_REFUSED[on] },
      blocked: { on, rules: rulesFor(written.refused, tools), copy: null },
    };
  }
  return { error: written.text !== null ? { thingId, on, text: written.text } : writes.error, blocked: writes.blocked };
}

function markKey(thingId: string, name: string): string {
  return `${thingId} ${name}`;
}

/** What the line under the marks says once a mark call went through. */
function markDone(tool: string, data: Record<string, unknown> | null): NonNullable<EverythingsWrites['last']>['did'] {
  const action = data?.action;
  if (tool === WRITE_TOOLS.addMark) return action === 'created' ? 'added' : 'already-on';
  return action === 'deleted' ? 'removed' : 'already-off';
}

/**
 * A press on a mark: the person's mark comes off when the cache says it is
 * theirs as the press runs, else goes on.
 */
export async function pressMark(p: Ports, thingId: string, mark: MarkPress): Promise<void> {
  const key = markKey(thingId, mark.name);
  const cached = (await p.cache.read()).things[thingId]?.marks?.find(one => one.name === mark.name);
  const isTheirs = cached?.mine === true;
  const now = await p.now();
  let isMine = false;
  await p.writes.update(writes => {
    const pending = live(writes.pending, now);
    isMine = pending[key] === undefined;
    if (!isMine) return writes;
    const error = writes.error?.thingId === thingId && writes.error.on === 'mark' ? null : writes.error;
    const did = isTheirs ? 'removing' : 'adding';
    return {
      ...writes,
      pending: { ...pending, [key]: now },
      error,
      last: { thingId, name: mark.name, emoji: mark.emoji, did, at: now },
    };
  });
  if (!isMine) return;

  const tool = isTheirs ? WRITE_TOOLS.removeMark : WRITE_TOOLS.addMark;
  const args = isTheirs ? { thingId, name: mark.name } : { thingId, emoji: mark.emoji, name: mark.name };
  let written: Written | null = null;
  try {
    written = await write(p, tool, args);
    if (written.ok) await recordWrite(p, tool, args, written.data);
  } finally {
    const outcome = written;
    await p.writes.update(writes => {
      const isLatest = writes.last?.thingId === thingId && writes.last.name === mark.name && writes.last.at === now;
      const last =
        !isLatest || writes.last === null
          ? writes.last
          : outcome?.ok === true
            ? { ...writes.last, did: markDone(tool, outcome.data) }
            : null;
      return { ...writes, pending: without(writes.pending, key), ...settled(writes, thingId, 'mark', outcome), last };
    });
  }
}

/**
 * A submitted comment, top level, sent as typed. Blank text sends nothing;
 * text past the server's limit sends nothing and says so. On success that
 * thing's field is drawn afresh (`posted`), empty; on a failure it stays as
 * typed. A comment in flight on one thing holds back only that thing's field.
 */
export async function submitComment(p: Ports, thingId: string, text: string): Promise<void> {
  if (!text.trim()) return;
  if (text.length > COMMENT_LIMIT) {
    await p.writes.update(writes => ({ ...writes, error: { thingId, on: 'comment', text: TOO_LONG } }));
    return;
  }
  const now = await p.now();
  let isMine = false;
  await p.writes.update(writes => {
    const commenting = live(writes.commenting, now);
    isMine = commenting[thingId] === undefined;
    if (!isMine) return writes;
    const error = writes.error?.thingId === thingId && writes.error.on === 'comment' ? null : writes.error;
    return { ...writes, commenting: { ...commenting, [thingId]: now }, error };
  });
  if (!isMine) return;

  const args = { thingId, content: text };
  let written: Written | null = null;
  try {
    written = await write(p, WRITE_TOOLS.comment, args);
    if (written.ok) await recordWrite(p, WRITE_TOOLS.comment, args, written.data, PERSON_AUTHOR);
  } finally {
    const outcome = written;
    await p.writes.update(writes => {
      let posted = writes.posted;
      if (outcome?.ok === true) {
        const { [thingId]: count = 0, ...others } = writes.posted;
        // The latest posts last, so the oldest go first past the bound.
        posted = Object.fromEntries([...Object.entries(others).slice(-(POSTED_KEPT - 1)), [thingId, count + 1]]);
      }
      return { ...writes, commenting: without(writes.commenting, thingId), posted, ...settled(writes, thingId, 'comment', outcome) };
    });
  }
}

export async function dismissWriteNote(p: Ports): Promise<void> {
  await p.writes.update(writes => (writes.blocked === null ? writes : { ...writes, blocked: null }));
}

/** The screen changed: a failure line and a mark's line left on the last page go. */
export async function leaveWrites(p: Ports): Promise<void> {
  await p.writes.update(writes =>
    writes.error === null && writes.last === null ? writes : { ...writes, error: null, last: null },
  );
}
