// Asking Claude to open a page the pane knows only by name.
//
// A tile the agent has not read has only a name and an emoji in the cache,
// and a workspace may have nothing listed yet. When the pane cannot fill the
// page itself (Claude Code refuses its reads, or a read failed), a Button
// submits one prompt as the person, naming the page by its id alone. Names
// are written by other members and by agents, and the prompt reads as the
// person's own words, so no name goes into it; an id that is not a plain
// id sends nothing. The agent then reads the page, and the follow hook
// records what that call carried, which fills it. `asked` names the page
// asked about, so the Button stays gone until the page fills or the person
// leaves the page.
//
// A search (`/findthing`) the pane could not run itself is asked for the
// same way. Its query is the person's own typed text, so it goes into the
// prompt, on one line; the agent's search_things answer then fills the list.

import type { EverythingsCache, EverythingsView } from '../types';
import { landingOf } from './cache';
import { cleanQuery, searchKey } from './data';
import type { Ports } from './ports';

/** What the pane may ask Claude to open. A workspace with no id is the one the pane opens on. */
export type AskTarget =
  | { kind: 'thing'; id: string }
  | { kind: 'workspace'; id: string | null }
  | { kind: 'search'; query: string };

/** The ids the server mints: letters, digits and dashes. */
const PLAIN_ID = /^[A-Za-z0-9-]{1,64}$/;

function keyOf(target: AskTarget): string {
  if (target.kind === 'search') return `search:${searchKey(target.query)}`;
  return target.kind === 'thing' ? `thing:${target.id}` : `workspace:${target.id ?? ''}`;
}

/** The page a view shows, as `asked` names it. */
export function askKey(view: EverythingsView, cache: EverythingsCache): string {
  if (view.kind === 'search') return keyOf({ kind: 'search', query: view.query });
  if (view.kind === 'inbox') return `inbox:${view.list}`;
  return view.kind === 'thing'
    ? keyOf({ kind: 'thing', id: view.thingId })
    : keyOf({ kind: 'workspace', id: landingOf(cache, view.workspaceId) });
}

/**
 * The prompt, in the person's words, naming the page by its id (a search by
 * the query they typed); null when the id is not a plain id or the query is empty.
 */
export function askText(target: AskTarget): string | null {
  if (target.kind === 'search') {
    const query = cleanQuery(target.query);
    return query ? `Search my Everythings things for "${query}" with search_things.` : null;
  }
  if (target.kind === 'workspace' && target.id === null) return 'Show me my default Everythings workspace in the Everythings pane.';
  if (target.id === null || !PLAIN_ID.test(target.id)) return null;
  return `Show me Everythings ${target.kind} ${target.id} in the Everythings pane.`;
}

/**
 * Submits one prompt as the person, once per pending page. The press marks
 * the page asked before it submits, so a second press finds the mark and
 * submits nothing. A prompt that did not enter clears the mark, so the
 * Button comes back.
 */
export async function askClaude(p: Ports, target: AskTarget): Promise<void> {
  const text = askText(target);
  if (text === null) return;
  const key = keyOf(target);
  let isMine = false;
  await p.asked.update(asked => {
    isMine = asked !== key;
    return key;
  });
  if (!isMine) return;
  let hasEntered = false;
  try {
    hasEntered = await p.askClaude(text);
  } catch {
    // Cleared below, as a prompt that did not enter.
  }
  if (!hasEntered) await p.asked.update(asked => (asked === key ? null : asked));
}

/** After the screen changed: an ask for a page no longer on screen goes, so its Button comes back there. */
export async function leaveAsk(p: Ports): Promise<void> {
  const asked = await p.asked.read();
  if (asked === null) return;
  const key = askKey(await p.view.read(), await p.cache.read());
  if (key !== asked) await p.asked.update(now => (now === asked ? null : now));
}
