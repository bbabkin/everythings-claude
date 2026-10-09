// The band above the prompt, and waking the session when a question is answered.
//
// The band shows two counts: the open questions agents asked the person
// (list_requests { status: 'open' }) and the open @Agent jobs people left in
// comments (list_mentions). Each is a Button that lists its items in the
// pane, where a press opens the thing; a count of zero, or one not known
// yet, draws nothing, so with both at zero the band is the engine's. The
// counts refresh at session start, after every Everythings call the session
// makes, and on Refresh. An agent call that was itself the whole listing
// (list_requests { status: 'open' } or list_mentions, over every workspace,
// not cut at its limit) fills its count with no read; otherwise the band
// makes one read of each list, on the learned server only (server.ts), never
// probing for one. A refused read stops the band's reads until Refresh,
// and blocks nothing else, as a refused search does; while the pane's own
// reads are blocked (blocked.ts) the band reads nothing either.
//
// Wake on answer: when this session's own request_input resolves, the
// question is remembered. While one is open, register.tsx runs one
// repeating `$.clock.every` that calls list_requests { status: 'answered' }
// every 5 minutes, for at most 2 hours after each ask. When an answer comes,
// the session is woken with one prompt naming the thing by its id alone
// (ask.ts's rule: an id that is not letters, digits and dashes sends
// nothing), once per question. A refused poll stops polling for the
// session; while the pane's reads are blocked a period reads nothing. The
// poll never calls what_changed, which would move the agent's cursor.

import type { EverythingsInbox, EverythingsInboxItem, EverythingsInboxList, EverythingsWait } from '../types';
import { isBlocked } from './blocked';
import {
  answerData,
  commentText,
  INBOX_TOOLS,
  isAnswered,
  isRecord,
  num,
  readResult,
  splitToolName,
  str,
} from './data';
import type { Ports } from './ports';
import { callLearnedServer, NotConnectedError, RefusedError } from './server';
import type { ToolCallResult } from 'claude-code';

/** How many rows the band asks for; the count says "100+" past it. */
export const INBOX_LIMIT = 100;
/** The server's default limit for both lists, when a call names none. */
const SERVER_LIMIT = 50;
/** How often the wake poll asks. */
export const WAKE_POLL_MS = 5 * 60_000;
/** How long after an ask the poll keeps asking. */
export const WAKE_LIMIT_MS = 2 * 60 * 60_000;
/** The poll's `since` reaches this far before the ask, for clocks that differ. */
const SINCE_SLACK_MS = 10 * 60_000;
const WOKE_KEPT = 100;
const TEXT_MAX = 300;

/** The ids the server mints: letters, digits and dashes. */
const PLAIN_ID = /^[A-Za-z0-9-]{1,64}$/;

const BOTH: readonly EverythingsInboxList[] = ['questions', 'jobs'];

function rows(data: Record<string, unknown>, field: string): unknown[] {
  return Array.isArray(data[field]) ? (data[field] as unknown[]) : [];
}

function oneLineText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/** list_requests' rows as the band lists them. */
export function parseQuestions(data: Record<string, unknown>): EverythingsInboxItem[] {
  return rows(data, 'requests').flatMap(row => {
    if (!isRecord(row)) return [];
    const thingId = str(row.thingId, 100);
    if (!thingId) return [];
    const request = isRecord(row.request) ? row.request : {};
    return [
      {
        key: thingId,
        thingId,
        name: str(row.name) ?? 'Untitled',
        emoji: str(row.emoji, 32),
        workspaceName: str(row.workspaceName),
        text: oneLineText(str(request.question, 2_000) ?? ''),
      },
    ];
  });
}

/** list_mentions' rows as the band lists them. */
export function parseJobs(data: Record<string, unknown>): EverythingsInboxItem[] {
  return rows(data, 'mentions').flatMap(row => {
    if (!isRecord(row)) return [];
    const thingId = str(row.thingId, 100);
    const commentId = str(row.commentId, 100);
    if (!thingId || !commentId) return [];
    return [
      {
        key: commentId,
        thingId,
        name: str(row.thingName) ?? 'Untitled',
        emoji: str(row.thingEmoji, 32),
        workspaceName: str(row.workspaceName),
        text: oneLineText(commentText(row.content)),
      },
    ];
  });
}

const PARSE: Record<EverythingsInboxList, (data: Record<string, unknown>) => EverythingsInboxItem[]> = {
  questions: parseQuestions,
  jobs: parseJobs,
};

/** The band's own read of each list: every workspace, open only. */
const BAND_ARGS: Record<EverythingsInboxList, Record<string, unknown>> = {
  questions: { status: 'open', limit: INBOX_LIMIT },
  jobs: { status: 'open', limit: INBOX_LIMIT },
};

/** The list an agent's call listed whole: every workspace, open only, not cut at its limit. */
function wholeListing(
  name: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
): { list: EverythingsInboxList; items: EverythingsInboxItem[] } | null {
  if (data === null || args.workspaceId !== undefined || args.since !== undefined) return null;
  let list: EverythingsInboxList;
  if (name === INBOX_TOOLS.questions && args.status === 'open') list = 'questions';
  else if (name === INBOX_TOOLS.jobs && (args.status === undefined || args.status === 'open')) list = 'jobs';
  else return null;
  const items = PARSE[list](data);
  return items.length < num(args.limit, SERVER_LIMIT) ? { list, items } : null;
}

async function setList(p: Ports, list: EverythingsInboxList, items: EverythingsInboxItem[]): Promise<void> {
  await p.inbox.update(inbox => ({ ...inbox, [list]: items }));
}

/**
 * An answered Everythings call of the agent's (follow.ts): a whole listing
 * of either list fills it. Answers the lists it filled, which the band then
 * need not read.
 */
export async function recordInboxCall(
  p: Ports,
  name: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
): Promise<EverythingsInboxList[]> {
  const whole = wholeListing(name, args, data);
  if (whole === null) return [];
  await setList(p, whole.list, whole.items);
  return [whole.list];
}

/**
 * Reads the lists not in `skip`, one call each on the learned server. Reads
 * nothing while the pane's reads are blocked, or after a refusal of the
 * band's own unless `isForced` (Refresh). A refusal stops the band's reads;
 * a read that succeeds lets them go on. No server learned yet, or a failure:
 * the count stands as it was.
 */
export async function refreshInbox(
  p: Ports,
  skip: readonly EverythingsInboxList[] = [],
  isForced = false,
): Promise<void> {
  if (await isBlocked(p)) return;
  if (!isForced && (await p.inbox.read()).isRefused) return;
  for (const list of BOTH) {
    if (skip.includes(list)) continue;
    try {
      const answer = readResult(await callLearnedServer(p, INBOX_TOOLS[list], BAND_ARGS[list]));
      if ('error' in answer) continue;
      const items = PARSE[list](answer.data);
      await p.inbox.update(inbox => ({ ...inbox, [list]: items, isRefused: false }));
    } catch (error) {
      if (error instanceof RefusedError) {
        await p.inbox.update(inbox => ({ ...inbox, isRefused: true }));
        return;
      }
      if (error instanceof NotConnectedError) return;
      // Another failure leaves the count as it stood.
    }
  }
}

/** The band's counts: null while unknown. */
export function countsOf(inbox: EverythingsInbox): Record<EverythingsInboxList, number | null> {
  return { questions: inbox.questions?.length ?? null, jobs: inbox.jobs?.length ?? null };
}

/** A count as the band draws it, "100+" when the read was cut at its limit. */
export function countText(count: number): string {
  return count >= INBOX_LIMIT ? `${INBOX_LIMIT}+` : String(count);
}

/** The prompt that wakes the session, naming the thing by its id; null for an id that is not a plain id. */
export function wakeText(thingId: string): string | null {
  if (!PLAIN_ID.test(thingId)) return null;
  return `The person answered the question you asked on Everythings thing ${thingId}. Read the answer (list_requests { status: 'answered' }, or get_thing on that thing) and carry on.`;
}

/**
 * The session's own request_input resolved: the question is waited on. A
 * thing id that is not a plain id is never waited on, since its wake could
 * not name it. Answers whether any question is waited on now.
 */
export async function watchAsk(p: Ports, tool: string, ran: ToolCallResult): Promise<boolean> {
  const parts = splitToolName(tool);
  if (parts === null || parts.name !== 'request_input' || !isAnswered(ran)) return false;
  const data = answerData(ran);
  const thingId = data !== null ? str(data.thingId, 100) : null;
  if (thingId === null || !PLAIN_ID.test(thingId)) return false;
  const request = data !== null && isRecord(data.request) ? data.request : {};
  const round = typeof request.round === 'number' && Number.isFinite(request.round) ? request.round : null;
  const askedAt = await p.now();
  const key = `${thingId}:${round ?? askedAt}`;
  const wake = await p.wake.update(last =>
    last.isStopped
      ? last
      : {
          ...last,
          waits: [...last.waits.filter(wait => wait.thingId !== thingId), { thingId, key, round, askedAt }],
        },
  );
  return wake.waits.length > 0;
}

/** True while a question is waited on and polling may go on. */
export async function isWaiting(p: Ports): Promise<boolean> {
  const wake = await p.wake.read();
  return !wake.isStopped && wake.waits.length > 0;
}

/** Whether an answered row answers the wait: its thing, and its round or a later one. */
function answers(row: unknown, wait: EverythingsWait): boolean {
  if (!isRecord(row) || row.thingId !== wait.thingId) return false;
  const request = isRecord(row.request) ? row.request : {};
  if (request.status !== undefined && request.status !== 'answered') return false;
  return wait.round === null || typeof request.round !== 'number' || request.round >= wait.round;
}

/**
 * One period of the wake poll. Waits older than two hours go; then one
 * list_requests { status: 'answered' } call, since a little before the
 * oldest ask. Each wait it answers wakes the session once. Answers whether
 * the poll should go on.
 */
export async function pollAnswers(p: Ports): Promise<boolean> {
  const now = await p.now();
  const wake = await p.wake.update(last => {
    const waits = last.waits.filter(wait => now - wait.askedAt <= WAKE_LIMIT_MS);
    return waits.length === last.waits.length ? last : { ...last, waits };
  });
  if (wake.isStopped || wake.waits.length === 0) return false;
  if (await isBlocked(p)) return true;

  const oldest = Math.min(...wake.waits.map(wait => wait.askedAt));
  let found: unknown[];
  try {
    const answer = readResult(
      await callLearnedServer(p, INBOX_TOOLS.questions, {
        status: 'answered',
        since: new Date(Math.max(0, oldest - SINCE_SLACK_MS)).toISOString(),
        limit: INBOX_LIMIT,
      }),
    );
    if ('error' in answer) return true;
    found = rows(answer.data, 'requests');
  } catch (error) {
    if (error instanceof RefusedError) {
      await p.wake.update(last => ({ ...last, waits: [], isStopped: true }));
      return false;
    }
    // No server reached, or a failure: the next period asks again.
    return true;
  }

  const answered = wake.waits.filter(wait => found.some(row => answers(row, wait)));
  if (answered.length === 0) return true;
  // Worked out before the write: a change may run more than once (ports.ts).
  const woke = (await p.wake.read()).woke;
  const toWake = answered.filter(wait => !woke.includes(wait.key));
  const after = await p.wake.update(last => ({
    ...last,
    waits: last.waits.filter(wait => !answered.some(done => done.key === wait.key)),
    woke: [...last.woke, ...toWake.map(wait => wait.key).filter(key => !last.woke.includes(key))].slice(-WOKE_KEPT),
  }));
  for (const wait of toWake) {
    const text = wakeText(wait.thingId);
    if (text === null) continue;
    try {
      await p.wakeSession(text);
    } catch {
      // The question still counts as woken: it never wakes the session twice.
    }
  }
  return !after.isStopped && after.waits.length > 0;
}
