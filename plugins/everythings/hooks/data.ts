// Pure helpers: tool names, payload parsing, and the text bounds the
// surfaces enforce. Nothing here touches `$`.
//
// Payload shapes follow apps/web/src/app/api/mcp/route.ts. A parser keeps
// only what the payload carried: a field it did not carry stays undefined,
// so the cache (cache.ts) knows it is unknown rather than empty.

import type { McpToolResult, ToolCallResult } from 'claude-code';

import type {
  EverythingsCachedThing,
  EverythingsChildren,
  EverythingsComment,
  EverythingsComments,
  EverythingsDefaultMark,
  EverythingsLoad,
  EverythingsRowMark,
  EverythingsMark,
  EverythingsRequest,
  EverythingsThingRef,
  EverythingsView,
  EverythingsWorkspace,
  EverythingsWrites,
} from '../types';

/** The pane's id: `$.ui.open`, `$.ui.panes` and the Pane render matcher. */
export const PANE_ID = 'everythings';
export const PANE_TITLE = 'Everythings';

export const APP_ORIGIN = 'https://www.everythings.app';

/** What a thing with no emoji shows, as on the web and the phone (`thing.emoji || '📄'`). */
export const NO_EMOJI = '📄';

export const INITIAL_VIEW: EverythingsView = { kind: 'grid', workspaceId: null };
export const IDLE_LOAD: EverythingsLoad = {
  seq: 0,
  key: '',
  isLoading: false,
  error: null,
  isNotConnected: false,
};

/** Markdown and Text both refuse a string longer than this. */
export const TEXT_MAX = 10_000;
/**
 * The engine refuses a drawing holding more than 100,000 characters of text,
 * counting every Text, label, Markdown text, link target and pressable link
 * (keys are free). A page keeps its own strings under this budget, and
 * PAGE_CHROME reserves room for what the pane adds around them: the header,
 * the status lines, notes and labels.
 */
const PAGE_TEXT_BUDGET = 95_000;
const PAGE_CHROME = 2_000;
const COMMENT_MAX = 2_000;
const COMMENTS_KEPT = 100;
/** Comment text kept per thing; more could never fit a page. */
const COMMENTS_TEXT_KEPT = 60_000;
const NAME_MAX = 200;

/** The reads the pane makes of its own: a grid, a thing's page, a workspace's default marks. */
export const READ_TOOLS = { grid: 'get_workspace_view', thing: 'get_thing_view', defaults: 'get_workspace' } as const;

/**
 * The writes the pane makes, each only on the person's own action: their
 * mark on a press, their comment on a submit. It calls no other tool.
 */
export const WRITE_TOOLS = { addMark: 'add_mark', removeMark: 'remove_mark', comment: 'add_comment' } as const;

export const IDLE_WRITES: EverythingsWrites = {
  pending: {},
  commenting: {},
  posted: {},
  error: null,
  blocked: null,
  last: null,
};

/** A mark or comment marker older than this is one an earlier load left: it blocks nothing. */
export const WRITE_STALE_MS = 30_000;

/** The most a comment holds (TEXT_LIMITS.commentContent on the server). */
export const COMMENT_LIMIT = 10_000;

/**
 * Tools of the Everythings MCP server (apps/web/src/app/api/mcp/route.ts)
 * whose names only it uses. An answered call of one names the server: the
 * pane reads from that server from then on, in this session and later ones.
 */
export const UNIQUE_TOOLS: ReadonlySet<string> = new Set([
  'what_changed', 'my_reception', 'search_things', 'get_thing', 'get_thing_view',
  'get_workspace_view', 'list_things', 'list_child_things', 'recent_things',
  'create_thing', 'update_thing', 'delete_thing', 'restore_thing', 'move_thing',
  'reorder_things', 'copy_thing', 'claim_thing', 'release_thing', 'request_input',
  'answer_request', 'resolve_request', 'list_requests',
]);

/**
 * Its tools whose names another server may use too (a Notion `search`, a
 * Linear `add_comment`). A call of one counts as an Everythings call only on
 * the server already learned.
 */
export const GENERIC_TOOLS: ReadonlySet<string> = new Set([
  'search', 'fetch', 'list_workspaces', 'get_workspace', 'create_workspace',
  'rename_workspace', 'list_comments', 'list_marks', 'list_trash', 'add_comment',
  'add_mark', 'remove_mark', 'list_mentions', 'resolve_mention',
]);

/** The Everythings tools that only read. An answered call of any other is a write. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'what_changed', 'my_reception', 'search_things', 'get_thing', 'get_thing_view',
  'get_workspace_view', 'list_things', 'list_child_things', 'recent_things', 'list_requests',
  'search', 'fetch', 'list_workspaces', 'get_workspace', 'list_comments', 'list_marks',
  'list_trash', 'list_mentions',
]);

/** The writes the pane follows. */
export const FOLLOWED_WRITES: ReadonlySet<string> = new Set([
  'create_thing', 'update_thing', 'move_thing', 'delete_thing', 'restore_thing',
  'add_mark', 'remove_mark', 'add_comment', 'request_input', 'answer_request',
  'resolve_request', 'copy_thing', 'resolve_mention',
]);

/**
 * Writes whose thing id is in the result: the new thing, the copy, the thing
 * a question was asked on, the thing of the comment a mention was in.
 */
const ID_FROM_RESULT: ReadonlySet<string> = new Set([
  'create_thing', 'copy_thing', 'request_input', 'resolve_mention',
]);

/** What a followed write asks of the pane. */
export type WriteTarget = { kind: 'open'; thingId: string } | { kind: 'deleted'; thingId: string };

export function viewKey(view: EverythingsView): string {
  return view.kind === 'grid' ? `grid:${view.workspaceId ?? ''}` : `thing:${view.thingId}`;
}

export function thingUrl(workspaceId: string, thingId: string): string {
  return `${APP_ORIGIN}/workspaces/${encodeURIComponent(workspaceId)}/things/${encodeURIComponent(thingId)}`;
}

/**
 * Splits `mcp__<server>__<tool>` at its last `__`. In the desktop app the
 * Everythings connector runs under a UUID; in a terminal under `everythings`
 * or `claude_ai_Everythings`. Either way the server part is a name
 * `$.mcp.call` takes.
 */
export function splitToolName(tool: string): { server: string; name: string } | null {
  if (!tool.startsWith('mcp__')) return null;
  const rest = tool.slice('mcp__'.length);
  const at = rest.lastIndexOf('__');
  if (at <= 0) return null;
  const server = rest.slice(0, at);
  const name = rest.slice(at + 2);
  return server && name ? { server, name } : null;
}

export function isAnswered(ran: ToolCallResult): boolean {
  return ran.deny === undefined && ran.isError !== true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function blocksJson(blocks: unknown[]): unknown {
  const text = blocks.map(block => (isRecord(block) && typeof block.text === 'string' ? block.text : '')).join('');
  return parseJson(text);
}

/**
 * A tool call's JSON answer, wherever the engine put it: the result record
 * itself, its structured content, its content blocks, or the text the model
 * read. Null when none of them holds a JSON object.
 */
export function answerData(ran: ToolCallResult): Record<string, unknown> | null {
  const result: unknown = ran.result;
  const candidates: unknown[] = [];
  if (isRecord(result)) {
    candidates.push(result.structuredContent);
    if (Array.isArray(result.content)) candidates.push(blocksJson(result.content));
    else candidates.push(result);
  }
  if (Array.isArray(result)) candidates.push(blocksJson(result));
  if (typeof result === 'string') candidates.push(parseJson(result));
  if (typeof ran.text === 'string') candidates.push(parseJson(ran.text));
  for (const one of candidates) if (isRecord(one)) return one;
  return null;
}

/** Which thing a followed write is about, or null when it names none. */
export function writeTarget(
  name: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
): WriteTarget | null {
  const fromArgs = typeof args.thingId === 'string' && args.thingId ? args.thingId : null;
  const fromResult = data && typeof data.thingId === 'string' && data.thingId ? data.thingId : null;
  const thingId = ID_FROM_RESULT.has(name) ? (fromResult ?? fromArgs) : fromArgs;
  if (!thingId) return null;
  return name === 'delete_thing' ? { kind: 'deleted', thingId } : { kind: 'open', thingId };
}

/** An MCP result as JSON data, or the server's error text as one line. */
export function readResult(result: McpToolResult): { data: Record<string, unknown> } | { error: string } {
  const text = result.content
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
  if (result.isError) return { error: oneLine(text) || 'The Everythings server reported an error.' };
  if (isRecord(result.structuredContent)) return { data: result.structuredContent };
  const data = parseJson(text);
  return isRecord(data) ? { data } : { error: 'The Everythings server sent a reply the pane cannot read.' };
}

/** Strips control characters (tab and newline survive when `isMultiline`). */
export function clean(value: unknown, max: number, isMultiline = false): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(isMultiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  return cut(text, max);
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Cells one character takes on a terminal: 2 for wide CJK and most emoji, else 1. */
function cellsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);
  return isWide ? 2 : 1;
}

/** `text` cut to fit `cells` terminal cells, ending in an ellipsis when cut. */
export function clip(text: string, cells: number): string {
  const chars = Array.from(text);
  if (chars.reduce((sum, char) => sum + cellsOf(char), 0) <= cells) return text;
  let kept = '';
  let used = 0;
  for (const char of chars) {
    used += cellsOf(char);
    if (used > cells - 1) break;
    kept += char;
  }
  return `${kept.trimEnd()}…`;
}

export function oneLine(text: string): string {
  return clean(text.split('\n').find(line => line.trim()) ?? '', 300).trim();
}

export function str(value: unknown, max = NAME_MAX): string | null {
  const text = clean(value, max).trim();
  return text ? text : null;
}

export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A thing as one payload carried it; a field it did not carry is undefined. */
export type ThingRecord = Omit<EverythingsCachedThing, 'name' | 'emoji' | 'seen' | 'pageSeen'> & {
  name?: string;
  emoji?: string | null;
};

/** A thing in a listing: its id, name and emoji, and where it sits when the listing says. */
export function parseRef(item: unknown): ThingRecord | null {
  if (!isRecord(item)) return null;
  const id = str(item.id, 100);
  if (!id) return null;
  const record: ThingRecord = { id, name: str(item.name) ?? 'Untitled', emoji: str(item.emoji, 32) };
  const workspaceId = str(item.workspaceId, 100);
  if (workspaceId) record.workspaceId = workspaceId;
  if ('parentId' in item) record.parentId = str(item.parentId, 100);
  const marks = parseRowMarks(item.marks);
  if (marks !== null) record.rowMarks = marks;
  return record;
}

/** At most this many marks are kept per thing for its list row. */
export const ROW_MARKS_KEPT = 12;

/** Marks as a list row keeps them: each with a count, at most ROW_MARKS_KEPT. */
export function toRowMarks(marks: readonly { name: string; emoji: string; count: number }[]): EverythingsRowMark[] {
  return marks
    .filter(mark => mark.count > 0)
    .slice(0, ROW_MARKS_KEPT)
    .map(mark => ({ name: mark.name, emoji: mark.emoji, count: mark.count }));
}

/** A listed thing's `marks`, which the view tools carry; null when the answer has none (the older shape). */
export function parseRowMarks(value: unknown): EverythingsRowMark[] | null {
  if (!Array.isArray(value)) return null;
  return toRowMarks(
    value.flatMap(item => {
      if (!isRecord(item)) return [];
      const name = str(item.name, 100);
      const emoji = str(item.emoji, 32);
      return name && emoji ? [{ name, emoji, count: num(item.count, 1) }] : [];
    }),
  );
}

export function parseRefs(value: unknown): ThingRecord[] {
  return list(value).flatMap(item => parseRef(item) ?? []);
}

export function asRef(record: ThingRecord): EverythingsThingRef {
  return { id: record.id, name: record.name ?? 'Untitled', emoji: record.emoji ?? null };
}

export function parseWorkspaces(value: unknown): EverythingsWorkspace[] {
  return list(value).flatMap(item => {
    if (!isRecord(item)) return [];
    const id = str(item.id, 100);
    return id ? [{ id, name: str(item.name) ?? 'Untitled', isDefault: item.isDefault === true }] : [];
  });
}

/** Thing content as the pane keeps it: at most 10,000 characters, null when empty. */
export function parseContent(value: unknown): { content: string | null; isContentCut: boolean } {
  const raw = typeof value === 'string' ? clean(value, Number.MAX_SAFE_INTEGER, true) : '';
  const kept = clean(raw, TEXT_MAX, true);
  return { content: kept.trim() ? kept : null, isContentCut: kept.length < raw.length };
}

export function parseRequest(value: unknown): EverythingsRequest | null {
  if (!isRecord(value)) return null;
  const question = str(value.question, 2_000);
  if (!question) return null;
  const answer = isRecord(value.answer) ? value.answer : null;
  return {
    question,
    options: list(value.options).flatMap(option => {
      if (!isRecord(option)) return [];
      const label = str(option.label);
      return label
        ? [{ id: str(option.id, 100) ?? label, label, description: str(option.description, 500) }]
        : [];
    }),
    status: str(value.status, 32) ?? 'open',
    createdBy: str(value.createdBy, 100),
    answer: answer
      ? {
          optionId: str(answer.optionId, 100),
          optionLabel: str(answer.optionLabel),
          comment: str(answer.comment, 2_000),
          userName: str(answer.userName, 100),
          via: str(answer.via, 16),
        }
      : null,
  };
}

export function parseMarks(value: unknown): EverythingsMark[] {
  const marks = isRecord(value) ? value.marks : value;
  return list(marks).flatMap(item => {
    if (!isRecord(item)) return [];
    const name = str(item.name, 100);
    const emoji = str(item.emoji, 32);
    return name && emoji ? [{ name, emoji, count: num(item.count, 1), mine: item.mine === true }] : [];
  });
}

/** get_workspace's `defaultMarks`, at most 8 as the workspace keeps them; null when the answer has none. */
export function parseDefaultMarks(data: unknown): EverythingsDefaultMark[] | null {
  if (!isRecord(data) || !Array.isArray(data.defaultMarks)) return null;
  return data.defaultMarks.slice(0, 8).flatMap(item => {
    if (!isRecord(item)) return [];
    const name = str(item.name, 100);
    const emoji = str(item.emoji, 32);
    return name && emoji ? [{ name, emoji }] : [];
  });
}

/** Mention tokens drawn as `@Name` (packages/shared/src/mentions.ts). */
const MENTION_TOKEN = /@\[([^\]\n]*)\]\((user:[^)\s]+|agent)\)/g;

export function commentText(value: unknown): string {
  return clean(String(value ?? '').replace(MENTION_TOKEN, '@$1'), COMMENT_MAX, true).trim();
}

/** Comments in order, as many as the cache keeps. */
export function parseComments(value: unknown): EverythingsComments {
  const page = isRecord(value) ? value : {};
  const all = list(page.comments);
  const kept: EverythingsComment[] = [];
  let room = COMMENTS_TEXT_KEPT;
  for (const item of all) {
    if (!isRecord(item)) continue;
    if (kept.length >= COMMENTS_KEPT) break;
    const id = str(item.id, 100);
    if (!id) continue;
    const text = commentText(item.content);
    if (text.length > room) break;
    room -= text.length;
    kept.push({
      id,
      authorName: str(item.authorName, 100) ?? 'Someone',
      byAgent: str(item.byAgent, 100),
      parentId: str(item.parentId, 100),
      text,
    });
  }
  const count = num(page.count, all.length);
  return { list: kept, count, truncated: page.truncated === true || kept.length < count };
}

export function parseChildren(value: unknown): { records: ThingRecord[]; section: EverythingsChildren } {
  const page = isRecord(value) ? value : {};
  const records = parseRefs(page.things);
  const count = num(page.count, records.length);
  return {
    records,
    section: { things: records.map(asRef), count, truncated: page.truncated === true || records.length < count },
  };
}

/** get_thing's answer, or the `thing` of get_thing_view's. */
export function parseThing(value: unknown): ThingRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value.id, 100);
  if (!id) return null;
  return {
    id,
    name: str(value.name) ?? 'Untitled',
    emoji: str(value.emoji, 32),
    ...parseContent(value.content),
    ...(str(value.workspaceId, 100) ? { workspaceId: str(value.workspaceId, 100) as string } : {}),
    ...('parentId' in value ? { parentId: str(value.parentId, 100) } : {}),
    agent: str(value.updatedByAgent, 100) ?? str(value.createdByAgent, 100),
    request: parseRequest(value.request),
  };
}

/** get_thing_view's answer: the whole page of one thing. */
export type ThingViewRecord = {
  thing: ThingRecord;
  workspace: { id: string; name: string } | null;
  ancestors: ThingRecord[];
  children: ReturnType<typeof parseChildren>;
};

export function parseThingView(data: unknown): ThingViewRecord | null {
  if (!isRecord(data)) return null;
  const thing = parseThing(data.thing);
  if (!thing) return null;
  const space = isRecord(data.workspace) ? data.workspace : {};
  const workspaceId = str(space.id, 100) ?? thing.workspaceId ?? null;
  const children = parseChildren(data.children);
  return {
    thing: { ...thing, marks: parseMarks(data.marks), comments: parseComments(data.comments), children: children.section },
    workspace: workspaceId ? { id: workspaceId, name: str(space.name) ?? 'Workspace' } : null,
    ancestors: parseRefs(data.ancestors),
    children,
  };
}

/** get_workspace_view's answer: the workspaces and the landing workspace's top-level things. */
export type GridRecord = {
  workspaces: EverythingsWorkspace[];
  defaultWorkspaceId: string | null;
  landing: { workspaceId: string; things: ThingRecord[]; count: number } | null;
};

export function parseGridView(data: unknown): GridRecord | null {
  if (!isRecord(data) || !Array.isArray(data.workspaces)) return null;
  const landing = isRecord(data.landing) ? data.landing : null;
  const landingId = landing ? str(landing.workspaceId, 100) : null;
  const things = landing ? parseRefs(landing.things) : [];
  const count = landing ? num(landing.count, things.length) : 0;
  return {
    workspaces: parseWorkspaces(data.workspaces),
    defaultWorkspaceId: str(data.defaultWorkspaceId, 100),
    landing: landing && landingId ? { workspaceId: landingId, things, count } : null,
  };
}

/** Looks like HTML the server will convert, so the stored Markdown is not knowable from the input. */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(p|div|br|ul|ol|li|h[1-6]|table|tr|td|strong|em|b|i|a|span|blockquote|pre|code)\b[^>]*>/i.test(text);
}

/** Links in content that open another thing in the pane. */
const THING_LINK = /https:\/\/(?:www\.)?everythings\.app\/workspaces\/[A-Za-z0-9-]+\/things\/([A-Za-z0-9-]+)/g;

export function thingLinks(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(THING_LINK)) {
    if (found.size >= 256) break;
    found.add(match[0]);
  }
  return [...found];
}

export function thingIdFromLink(href: string): string | null {
  const match = new RegExp(THING_LINK.source).exec(href);
  return match ? (match[1] ?? null) : null;
}

/** One thing's page as the pane draws it: what is known, fitted to the text budget. Null is an absent section. */
export type DrawnPage = {
  id: string;
  name: string;
  emoji: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  /** The thing it sits under, as the cache knows it; null at the top level or when unknown. */
  parent: EverythingsThingRef | null;
  content: string | null;
  isContentCut: boolean;
  links: string[];
  agent: string | null;
  request: EverythingsRequest | null;
  /** Null while no read carried its marks. */
  marks: EverythingsMark[] | null;
  /** Its workspace's default marks; null while unknown. */
  defaultMarks: EverythingsDefaultMark[] | null;
  children: DrawnChildren | null;
  comments: EverythingsComments | null;
  /** Only the name and emoji are known: no content or section was recorded, or it was pruned. */
  isNameOnly: boolean;
  /** Its page was recorded once and pruned to keep the cache in bounds. */
  isPruned: boolean;
};

/** The grid as the pane draws it. `isListed`: a full listing of the workspace was seen. */
export type DrawnGrid = {
  workspaces: EverythingsWorkspace[];
  landing: {
    workspaceId: string;
    things: EverythingsThingRef[];
    count: number;
    truncated: boolean;
    isListed: boolean;
  } | null;
};

/** A sub-thing as its row draws it: the ref, and its marks (null while unknown). */
export type DrawnChild = EverythingsThingRef & { marks: EverythingsRowMark[] | null };
export type DrawnChildren = { things: DrawnChild[]; count: number; truncated: boolean };

/** How many mark emojis a row shows before it says how many more there are. */
export const ROW_MARKS_SHOWN = 5;

/** The text a card or sub-thing row draws: the emoji (or NO_EMOJI), a separator, the name. */
function refCost(ref: EverythingsThingRef): number {
  return ref.name.length + (ref.emoji ?? NO_EMOJI).length + 1;
}

/** What a row's marks add to its label: up to ROW_MARKS_SHOWN emojis with spaces, "+n" and " | ". */
function rowMarksCost(marks: EverythingsRowMark[] | null): number {
  if (!marks || marks.length === 0) return 0;
  return marks.slice(0, ROW_MARKS_SHOWN).reduce((sum, mark) => sum + mark.emoji.length + 1, 0) + 8;
}

/** Keeps the refs that fit in `budget.left`, in order, and spends it. */
function fitRefs(refs: EverythingsThingRef[], budget: { left: number }): EverythingsThingRef[] {
  const kept: EverythingsThingRef[] = [];
  for (const ref of refs) {
    if (refCost(ref) > budget.left) break;
    budget.left -= refCost(ref);
    kept.push(ref);
  }
  return kept;
}

/** The text drawRequest in pane.tsx draws for a question. */
function requestCost(request: EverythingsRequest | null): number {
  if (!request) return 0;
  const options = request.options.reduce(
    (sum, option) => sum + option.label.length + (option.description?.length ?? 0) + 4,
    0,
  );
  const answer = request.answer;
  const answered = answer
    ? (answer.optionLabel?.length ?? 0) + (answer.comment?.length ?? 0) + (answer.userName?.length ?? 0) + 40
    : 40;
  return (request.createdBy?.length ?? 0) + 20 + request.question.length + options + answered;
}

/**
 * A cached thing as a page to draw. The page's text is spent in the order
 * the pane draws it, so what drops off first is the end of the page:
 * comments, then sub-things, then links that would have opened in the pane
 * (they open in the browser instead).
 */
export function fitPage(
  thing: EverythingsCachedThing,
  workspaceName: string | null,
  parent: EverythingsThingRef | null,
  defaultMarks: EverythingsDefaultMark[] | null,
  rowMarksOf: (thingId: string) => EverythingsRowMark[] | undefined = () => undefined,
): DrawnPage {
  const content = thing.content ?? null;
  const request = thing.request ?? null;
  const marks = thing.marks ?? null;
  const workspaceId = thing.workspaceId ?? null;
  const budget = { left: PAGE_TEXT_BUDGET - PAGE_CHROME };
  budget.left -= (workspaceName?.length ?? 0) + thing.name.length + (thing.emoji ?? NO_EMOJI).length + (thing.agent?.length ?? 0);
  // The header's Button back to the parent; its label never grows past the name it clips.
  budget.left -= parent ? refCost(parent) : 0;
  // A mark Button draws a state glyph, its emoji and its count; a default mark's draws the glyph and
  // the emoji. The line under the marks (a mark's name, at most 100, and a few words) is in PAGE_CHROME.
  budget.left -= (marks ?? []).reduce((sum, mark) => sum + mark.emoji.length + 10, 0);
  budget.left -= (defaultMarks ?? []).reduce((sum, mark) => sum + mark.emoji.length + 2, 0);
  budget.left -= (workspaceId ? thingUrl(workspaceId, thing.id).length : 0) + (content?.length ?? 0) + requestCost(request);

  const links: string[] = [];
  for (const href of content !== null ? thingLinks(content) : []) {
    if (href.length > budget.left) break;
    budget.left -= href.length;
    links.push(href);
  }

  let children: DrawnChildren | null = null;
  if (thing.children) {
    const kept: DrawnChild[] = [];
    for (const ref of thing.children.things) {
      const marks = rowMarksOf(ref.id) ?? null;
      const cost = refCost(ref) + rowMarksCost(marks);
      if (cost > budget.left) break;
      budget.left -= cost;
      kept.push({ ...ref, marks });
    }
    children = { things: kept, count: thing.children.count, truncated: thing.children.truncated || kept.length < thing.children.count };
  }

  let comments: EverythingsComments | null = null;
  if (thing.comments) {
    const kept: EverythingsComment[] = [];
    for (const comment of thing.comments.list) {
      // Drawn as the author, "via <agent>" and the text.
      const cost = comment.authorName.length + (comment.byAgent ? comment.byAgent.length + 4 : 0) + comment.text.length;
      if (cost > budget.left) break;
      budget.left -= cost;
      kept.push(comment);
    }
    comments = { list: kept, count: thing.comments.count, truncated: thing.comments.truncated || kept.length < thing.comments.count };
  }

  return {
    id: thing.id,
    name: thing.name,
    emoji: thing.emoji,
    workspaceId,
    workspaceName,
    parent,
    content,
    isContentCut: thing.isContentCut === true,
    links,
    agent: thing.agent ?? null,
    request,
    marks,
    defaultMarks,
    children,
    comments,
    isNameOnly: thing.pageSeen === 0,
    isPruned: thing.isPruned === true,
  };
}

/** A grid's workspaces and tiles, fitted to the text budget. */
export function fitGrid(
  workspaces: EverythingsWorkspace[],
  landing: { workspaceId: string; things: EverythingsThingRef[]; count: number; isListed: boolean } | null,
): DrawnGrid {
  const budget = { left: PAGE_TEXT_BUDGET - PAGE_CHROME };
  // A picker option draws its name, and its value may count as text too.
  const named = workspaces.filter(ws => {
    budget.left -= ws.name.length + ws.id.length;
    return budget.left > 0;
  });
  if (!landing) return { workspaces: named, landing: null };
  const things = fitRefs(landing.things, budget);
  return {
    workspaces: named,
    landing: {
      workspaceId: landing.workspaceId,
      things,
      count: Math.max(landing.count, landing.things.length),
      truncated: things.length < Math.max(landing.count, landing.things.length),
      isListed: landing.isListed,
    },
  };
}
