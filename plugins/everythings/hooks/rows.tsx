// Transcript rows: an Everythings write the agent made reads as one compact
// row, the verb and the thing ("updated 🍋 Lemon cake"), its name a Link
// to the thing in the app, in place of the tool's name over its JSON.
//
// register.tsx's `ui.render` hooks on `ToolUse` and `ToolResult` call these
// for the write tools in ROW_TOOLS. The two must agree: where the call row
// draws compact, the result block under it draws nothing; where it does
// not, both are the engine's. A call is drawn compact only once it resolved
// without an error, on a server known as Everythings (server.ts: any server
// for a tool name only Everythings has, the learned server for a shared
// name such as add_mark), with a JSON answer that does not report failure.
// Anything else, a running or interrupted call among them, keeps the
// engine's own row. The thing's name and emoji come from the call itself,
// else from the session cache (cache.ts); without a name the row shows the
// thing's id.

import type { ElementTable, RenderElement } from 'claude-code';

import type { EverythingsCache, EverythingsCachedThing } from '../types';
import { clip, isRecord, NO_EMOJI, outputData, splitToolName, str, thingUrl, UNIQUE_TOOLS } from './data';
import type { Ports } from './ports';
import { isLearnedServer } from './server';

/** The write tools whose transcript rows are drawn compact, with the verb each row reads. */
export const ROW_VERBS: Readonly<Record<string, string>> = {
  create_thing: 'created',
  update_thing: 'updated',
  move_thing: 'moved',
  delete_thing: 'trashed',
  restore_thing: 'restored',
  copy_thing: 'copied',
  add_mark: 'marked',
  remove_mark: 'unmarked',
  add_comment: 'commented on',
  request_input: 'asked about',
};

/** Writes whose thing is the one in the answer: the new thing, the copy, the thing a question went on. */
const ID_FROM_ANSWER: ReadonlySet<string> = new Set(['create_thing', 'copy_thing', 'request_input']);

/** The most cells a thing's name takes in a row. */
const NAME_CELLS = 80;

/** What one compact row says. `href` is null when the thing's workspace is unknown, or it went to Trash. */
export type WriteRow = { verb: string; thing: string; suffix: string | null; href: string | null };

/**
 * The tool's short name and its JSON answer when the call is drawn compact,
 * else null: the engine's own row stays.
 */
export async function judgeRow(
  p: Ports,
  tool: string,
  isErrored: boolean,
  output: unknown,
): Promise<{ name: string; data: Record<string, unknown> } | null> {
  if (isErrored) return null;
  const parts = splitToolName(tool);
  if (!parts || !(parts.name in ROW_VERBS)) return null;
  if (!UNIQUE_TOOLS.has(parts.name) && !(await isLearnedServer(p, parts.server))) return null;
  const data = outputData(output);
  if (!data || data.success === false || data.isError === true) return null;
  return { name: parts.name, data };
}

/** The compact row of a resolved call, or null when the engine's own row stays (judgeRow). */
export async function writeRow(
  p: Ports,
  call: { tool: string; input: unknown; output?: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean },
): Promise<WriteRow | null> {
  if (call.isRunning || call.isInterrupted) return null;
  const judged = await judgeRow(p, call.tool, call.isErrored, call.output);
  if (!judged) return null;
  const { name, data } = judged;
  const input = isRecord(call.input) ? call.input : {};
  const cache = await p.cache.read();

  const fromInput = id(input.thingId);
  const fromAnswer = id(data.thingId);
  const thingId = ID_FROM_ANSWER.has(name) ? (fromAnswer ?? fromInput) : (fromInput ?? fromAnswer);
  const known = thingId ? cache.things[thingId] : undefined;
  // A copy's emoji is its source's.
  const source = name === 'copy_thing' && fromInput ? cache.things[fromInput] : undefined;

  const thingName =
    (name === 'create_thing' ? str(input.name) : null) ??
    (name === 'update_thing' || name === 'copy_thing' ? str(data.name) : null) ??
    (name === 'update_thing' ? str(input.name) : null) ??
    known?.name ??
    (name === 'request_input' ? str(input.name) : null);
  const emoji = emojiOf(name, input, data, known, source);
  const thing = thingName ? `${emoji ?? NO_EMOJI} ${clip(thingName, NAME_CELLS)}` : (thingId ?? 'a thing');

  const workspaceId =
    (name === 'create_thing' ? (id(data.workspaceId) ?? id(input.workspaceId)) : null) ??
    (name === 'copy_thing' ? id(input.targetWorkspaceId) : null) ??
    known?.workspaceId ??
    (name === 'request_input' ? (id(input.workspaceId) ?? workspaceOfUrl(data.url, thingId)) : null);
  const href = thingId && workspaceId && name !== 'delete_thing' ? thingUrl(workspaceId, thingId) : null;

  return { verb: ROW_VERBS[name] as string, thing, suffix: suffixOf(name, input, data, known, cache), href };
}

/** The row: the verb, then the thing as a Link to it in the app, then what was done to it. */
export function drawRow(els: ElementTable, row: WriteRow): RenderElement {
  const { Box, Text, Link } = els;
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text>{row.verb}</Text>
      {row.href !== null ? <Link href={row.href} label={row.thing} /> : <Text bold>{row.thing}</Text>}
      {row.suffix !== null && <Text>{row.suffix}</Text>}
    </Box>
  );
}

function id(value: unknown): string | null {
  return str(value, 100);
}

/** The thing's emoji: what the call set, else what the session knows; null for none. */
function emojiOf(
  name: string,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
  known: EverythingsCachedThing | undefined,
  source: EverythingsCachedThing | undefined,
): string | null {
  if (name === 'update_thing' && 'emoji' in data) return str(data.emoji, 32);
  if (name === 'create_thing') return str(input.emoji, 32);
  if (name === 'update_thing' && typeof input.emoji === 'string') return str(input.emoji, 32);
  return known?.emoji ?? source?.emoji ?? null;
}

/** The mark (emoji and name), the new place, or nothing. */
function suffixOf(
  name: string,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
  known: EverythingsCachedThing | undefined,
  cache: EverythingsCache,
): string | null {
  if (name === 'add_mark') return markLabel(str(input.emoji, 32), str(input.name, 100));
  if (name === 'remove_mark') {
    const markName = str(input.name, 100);
    const mark = known?.marks?.find(one => one.name === markName) ?? known?.rowMarks?.find(one => one.name === markName);
    return markLabel(mark?.emoji ?? null, markName);
  }
  if (name === 'move_thing') {
    const parentId = 'newParentId' in data ? id(data.newParentId) : id(input.newParentId);
    if (!parentId) return 'to the top level';
    const parent = cache.things[parentId];
    return `under ${parent ? `${parent.emoji ?? NO_EMOJI} ${clip(parent.name, NAME_CELLS)}` : parentId}`;
  }
  return null;
}

/** `✅ done`, or the emoji alone when the mark is named by it. */
function markLabel(emoji: string | null, markName: string | null): string | null {
  if (emoji && markName && markName !== emoji) return `${emoji} ${markName}`;
  return emoji ?? markName;
}

/** The workspace in the app link request_input answers with, when it is that thing's. */
function workspaceOfUrl(url: unknown, thingId: string | null): string | null {
  if (typeof url !== 'string' || !thingId) return null;
  const match = /\/workspaces\/([^/?#]+)\/things\/([^/?#]+)/.exec(url);
  if (!match || decodeURIComponent(match[2] as string) !== thingId) return null;
  return id(decodeURIComponent(match[1] as string));
}
