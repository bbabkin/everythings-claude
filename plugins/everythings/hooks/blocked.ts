// When Claude Code refuses the pane's own reads.
//
// Under auto permission mode Claude Code was seen (2026-10-03, desktop Code
// tab) refusing every `$.mcp.call` the pane made, and repeating the call
// never helped. So the first refusal puts the pane in blocked mode for the
// session: navigation draws from the session cache at once and makes no read
// attempt, and no error line or Retry button shows. Refresh is the one way
// to try again: a read that succeeds ends blocked mode, another refusal
// keeps it quietly.
//
// While blocked, the pane shows one note: why it draws only what Claude has
// read, and the permission rules for its four read tools, with a Button that
// copies them. An allow rule for the two page reads was seen to lift the
// refusal. The search's rule is there too though a refused search blocks
// nothing (nav.ts): one copy then lets `/findthing` run as well. A refusal
// of a write (writes.ts) shows the same kind of note with that write's
// rules, beside the reads' note. The reads' note's Dismiss holds for the
// session (`$.state`) and for later sessions (`$.store`), until a Refresh
// the person presses is refused: that shows the note again, since it says
// why nothing changed, and clears the stored dismissal.

import type { RenderSurface } from 'claude-code';

import { READ_TOOLS, WRITE_TOOLS } from './data';
import type { Ports } from './ports';
import type { RefusedError } from './server';

const NOTE_DISMISSED = 'readsNoteDismissed';

const PANE_TOOLS = [...Object.values(READ_TOOLS), ...Object.values(WRITE_TOOLS)]
  .sort((a, b) => b.length - a.length)
  .join('|');
/** A tool name the engine's refusal named, which gives the server as permission rules spell it. */
const NAMED_TOOL = new RegExp(`\\bmcp__([A-Za-z0-9_-]+?)__(?:${PANE_TOOLS})\\b`);

/** The read tools the note asks to allow: every read the pane makes, so one copy covers the whole pane. */
export const READ_RULE_TOOLS: readonly string[] = [READ_TOOLS.thing, READ_TOOLS.grid, READ_TOOLS.defaults, READ_TOOLS.search];

/**
 * The allow rules for `tools` on the server that refused. The server part
 * is the one the refusal named, else the server's name with every character
 * a tool name cannot hold made `_`, as Claude Code does (`claude.ai
 * Everythings` is `claude_ai_Everythings`).
 */
export function rulesFor(refused: RefusedError, tools: readonly string[]): string[] {
  const spelled = NAMED_TOOL.exec(refused.message)?.[1] ?? refused.server.replace(/[^A-Za-z0-9_-]/g, '_');
  return tools.map(tool => `mcp__${spelled}__${tool}`);
}

export async function isBlocked(p: Ports): Promise<boolean> {
  return (await p.blocked.read()) !== null;
}

/** A refused read: the pane stops reading until Refresh. A note dismissed in an earlier session stays dismissed. */
export async function block(p: Ports, refused: RefusedError): Promise<void> {
  if (!(await p.noteDismissed.read())) {
    let isDismissed = false;
    try {
      isDismissed = (await p.storeGet(NOTE_DISMISSED)) === true;
    } catch {
      // An unreadable store shows the note; dismissing it writes the store again.
    }
    if (isDismissed) await p.noteDismissed.update(() => true);
  }
  const rules = rulesFor(refused, READ_RULE_TOOLS);
  await p.blocked.update(last =>
    last !== null && last.rules.join('\n') === rules.join('\n') ? last : { rules, copy: null },
  );
}

/** A read that succeeded: the pane reads again, and the note goes. */
export async function unblock(p: Ports): Promise<void> {
  if (await isBlocked(p)) await p.blocked.update(() => null);
}

export async function dismissNote(p: Ports): Promise<void> {
  await p.noteDismissed.update(() => true);
  await p.storeSet(NOTE_DISMISSED, true);
}

/**
 * A Refresh the person pressed was refused: the note shows again, and the
 * stored dismissal goes, so later sessions show it too until Dismiss.
 */
export async function showNote(p: Ports): Promise<void> {
  await p.noteDismissed.update(() => false);
  if ((await p.storeGet(NOTE_DISMISSED)) === true) await p.storeSet(NOTE_DISMISSED, false);
}

/** Puts a note's rules on the clipboard of the surface the press came from, one per line. */
async function copied(p: Ports, rules: string[], surface: RenderSurface): Promise<'copied' | 'failed'> {
  try {
    return (await p.copy(rules.join('\n'), surface)) ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Copies the read rules, or with `on: 'writes'` a refused write's, and says how it went. */
export async function copyRules(p: Ports, on: 'reads' | 'writes', surface: RenderSurface): Promise<void> {
  if (on === 'reads') {
    const blocked = await p.blocked.read();
    if (blocked === null) return;
    const copy = await copied(p, blocked.rules, surface);
    await p.blocked.update(last => (last === null ? last : { ...last, copy }));
  } else {
    const blocked = (await p.writes.read()).blocked;
    if (blocked === null) return;
    const copy = await copied(p, blocked.rules, surface);
    await p.writes.update(last => (last.blocked === null ? last : { ...last, blocked: { ...last.blocked, copy } }));
  }
}
