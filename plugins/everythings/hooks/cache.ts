// The session cache: what the agent's own Everythings calls carried and what
// the pane's reads brought, merged per thing and per workspace. The pane
// draws from it, so a thing the agent just wrote shows in full even when
// Claude Code refuses the pane's own read (under auto permission mode it
// may). Pure functions over EverythingsCache; nav.ts, follow.ts and writes.ts write the
// result to `$.state`.
//
// Bounds: at most THINGS_MAX things, and only the PAGES_KEPT whose pages
// were seen last keep content and sections; the rest keep a name and place.
// Each page is bounded on the way in (data.ts), so the cache stays around a
// megabyte at worst. Each thing also keeps at most 12 marks for its list row
// (ROW_MARKS_KEPT, a name up to 100 characters and an emoji up to 32): about
// 2,000 characters a thing, 600,000 over 300 things, only when every mark
// name is near its limit.

import type {
  EverythingsCache,
  EverythingsCachedThing,
  EverythingsChildren,
  EverythingsComments,
  EverythingsDefaultMark,
  EverythingsMark,
  EverythingsThingRef,
  EverythingsView,
} from '../types';
import {
  asRef,
  commentText,
  fitGrid,
  fitPage,
  isRecord,
  looksLikeHtml,
  num,
  parseComments,
  parseContent,
  parseChildren,
  parseDefaultMarks,
  parseGridView,
  parseMarks,
  parseRefs,
  parseRequest,
  parseThing,
  parseThingView,
  parseWorkspaces,
  searchKey,
  str,
  toRowMarks,
  type DrawnGrid,
  type DrawnHit,
  type DrawnPage,
  type DrawnSearch,
  type GridRecord,
  type ThingRecord,
  type ThingViewRecord,
} from './data';

export const THINGS_MAX = 300;
export const PAGES_KEPT = 8;
const ORDER_IDS_MAX = 300;
const ORDERS_MAX = 50;
const DELETED_MAX = 200;
const WORKSPACES_MAX = 200;
const SEARCHES_MAX = 10;

/** Who a comment the agent added in this session shows as, until a read brings the server's row. */
export const SESSION_AUTHOR = 'This session';
/** Who a comment the person added from the pane shows as, until a read brings the server's row. */
export const PERSON_AUTHOR = 'You';

export const EMPTY_CACHE: EverythingsCache = {
  tick: 0,
  things: {},
  workspaces: [],
  defaultWorkspaceId: null,
  order: {},
  deleted: {},
  defaultMarks: {},
  searches: {},
};

const PAGE_FIELDS: readonly string[] = ['content', 'isContentCut', 'request', 'marks', 'children', 'comments'];
const NO_CHILDREN: EverythingsChildren = { things: [], count: 0, truncated: false };
const NO_COMMENTS: EverythingsComments = { list: [], count: 0, truncated: false };

/** A cache being written: one record's worth of changes, stamped with one tick. */
type Draft = {
  tick: number;
  /** A thing recorded after this tick knows better than the record being applied. */
  since: number;
  things: Record<string, EverythingsCachedThing>;
  workspaces: EverythingsCache['workspaces'];
  defaultWorkspaceId: string | null;
  order: EverythingsCache['order'];
  deleted: Record<string, number>;
  defaultMarks: EverythingsCache['defaultMarks'];
  searches: EverythingsCache['searches'];
};

/** `since`: the tick a read started at; an observed call is as new as the cache. */
function open(cache: EverythingsCache, since = cache.tick): Draft {
  return {
    tick: cache.tick + 1,
    since,
    things: { ...cache.things },
    workspaces: [...cache.workspaces],
    defaultWorkspaceId: cache.defaultWorkspaceId,
    order: { ...cache.order },
    deleted: { ...cache.deleted },
    defaultMarks: { ...cache.defaultMarks },
    searches: { ...cache.searches },
  };
}

/** Merges what a record carried into the cached thing. Fields it did not carry stay as they were. */
function put(d: Draft, record: ThingRecord): void {
  const gone = d.deleted[record.id];
  if (gone !== undefined) {
    // Deleted after the read began: its answer predates the delete.
    if (gone > d.since) return;
    delete d.deleted[record.id];
  }
  const old = d.things[record.id];
  if (!old && record.name === undefined) return;
  // Something newer was recorded since the read began: fill gaps only.
  const isStale = old !== undefined && old.seen > d.since;
  const next: EverythingsCachedThing = old
    ? { ...old }
    : { id: record.id, name: record.name ?? 'Untitled', emoji: record.emoji ?? null, seen: 0, pageSeen: 0 };
  const fields = next as unknown as Record<string, unknown>;
  let isPage = false;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id' || value === undefined) continue;
    if (isStale && fields[key] !== undefined) continue;
    fields[key] = value;
    if (PAGE_FIELDS.includes(key)) isPage = true;
    // A page's marks are the freshest the row knows, unless a newer record gave the row its own.
    if (key === 'marks' && (!isStale || next.rowMarks === undefined)) {
      next.rowMarks = toRowMarks(value as EverythingsMark[]);
    }
  }
  next.seen = d.tick;
  if (isPage) {
    next.pageSeen = d.tick;
    delete next.isPruned;
  }
  d.things[record.id] = next;
}

/** Changes a known thing's page; an unknown thing is left alone. New marks give its row the same. */
function patch(d: Draft, id: string, change: (thing: EverythingsCachedThing) => EverythingsCachedThing | null): void {
  const old = d.things[id];
  if (!old) return;
  const next = change({ ...old });
  if (!next) return;
  const rowMarks = next.marks && next.marks !== old.marks ? toRowMarks(next.marks) : next.rowMarks;
  d.things[id] = { ...next, ...(rowMarks ? { rowMarks } : {}), seen: d.tick, pageSeen: d.tick };
}

/**
 * A mark write on a thing whose page marks are unknown but whose row marks
 * are known: "created" adds one, "deleted" takes one away. Only the row
 * changes; the thing stays as much a page as it was.
 */
function patchRow(d: Draft, id: string, name: string, emoji: string | null, step: 1 | -1): void {
  const old = d.things[id];
  if (!old?.rowMarks || old.marks) return;
  const known = old.rowMarks.find(mark => mark.name === name);
  const rowMarks = known
    ? old.rowMarks.map(mark => (mark.name === name ? { ...mark, count: mark.count + step } : mark))
    : step === 1 && emoji
      ? [...old.rowMarks, { name, emoji, count: 1 }]
      : old.rowMarks;
  d.things[id] = { ...old, rowMarks: toRowMarks(rowMarks), seen: d.tick };
}

function setOrder(d: Draft, workspaceId: string, ids: string[], count: number): void {
  delete d.order[workspaceId];
  d.order[workspaceId] = { ids, count };
}

/** Adds a thing under its parent's sub-things, or to its workspace's listing at the top level. */
function attach(d: Draft, thing: EverythingsCachedThing): void {
  if (thing.parentId === null && thing.workspaceId) {
    const listed = d.order[thing.workspaceId];
    if (listed && !listed.ids.includes(thing.id)) setOrder(d, thing.workspaceId, [...listed.ids, thing.id], listed.count + 1);
  } else if (thing.parentId) {
    patch(d, thing.parentId, parent =>
      parent.children && !parent.children.things.some(child => child.id === thing.id)
        ? {
            ...parent,
            children: {
              ...parent.children,
              things: [...parent.children.things, { id: thing.id, name: thing.name, emoji: thing.emoji }],
              count: parent.children.count + 1,
            },
          }
        : null,
    );
  }
}

/** Takes a thing out of every sub-things list and listing that holds it. */
function detach(d: Draft, id: string): void {
  for (const holder of Object.values(d.things)) {
    if (holder.children?.things.some(child => child.id === id)) {
      patch(d, holder.id, parent =>
        parent.children
          ? {
              ...parent,
              children: {
                ...parent.children,
                things: parent.children.things.filter(child => child.id !== id),
                count: Math.max(0, parent.children.count - 1),
              },
            }
          : null,
      );
    }
  }
  for (const [workspaceId, listed] of Object.entries(d.order)) {
    if (listed.ids.includes(id)) {
      d.order[workspaceId] = { ids: listed.ids.filter(one => one !== id), count: Math.max(0, listed.count - 1) };
    }
  }
}

/** A delete: the thing and what is cached under it go, and stay gone for reads that began before. */
function remove(d: Draft, id: string, visited = new Set<string>()): void {
  if (visited.has(id)) return;
  visited.add(id);
  for (const child of Object.values(d.things)) {
    if (child.parentId === id) remove(d, child.id, visited);
  }
  detach(d, id);
  delete d.things[id];
  d.deleted[id] = d.tick;
}

function nameWorkspace(d: Draft, id: string | null, name: string | null): void {
  if (!id || !name) return;
  const known = d.workspaces.findIndex(ws => ws.id === id);
  if (known >= 0) d.workspaces[known] = { ...d.workspaces[known]!, name };
  else d.workspaces.push({ id, name, isDefault: false });
}

/** A listing of a workspace's top-level things, in the server's order. */
function applyListing(d: Draft, workspaceId: string, records: ThingRecord[], count: number): void {
  for (const record of records) put(d, { ...record, parentId: null, workspaceId });
  const ids = records.map(record => record.id).filter(id => d.things[id] !== undefined);
  setOrder(d, workspaceId, ids, Math.max(count, ids.length));
  if (records.length < count) return;
  // A whole listing: what it left out is no longer at the top level, unless recorded since.
  for (const thing of Object.values(d.things)) {
    if (thing.workspaceId === workspaceId && thing.parentId === null && !ids.includes(thing.id) && thing.seen <= d.since) {
      const { parentId: _gone, ...rest } = thing;
      d.things[thing.id] = rest;
    }
  }
}

function applyThingView(d: Draft, view: ThingViewRecord): void {
  const workspaceId = view.workspace?.id ?? view.thing.workspaceId;
  put(d, view.thing);
  nameWorkspace(d, view.workspace?.id ?? null, view.workspace?.name ?? null);
  let parentId: string | null = null;
  for (const ancestor of view.ancestors) {
    put(d, { ...ancestor, parentId, ...(workspaceId ? { workspaceId } : {}) });
    parentId = ancestor.id;
  }
  for (const child of view.children.records) {
    const childWorkspace = child.workspaceId ?? workspaceId;
    put(d, { ...child, parentId: view.thing.id, ...(childWorkspace ? { workspaceId: childWorkspace } : {}) });
  }
}

function applyGrid(d: Draft, grid: GridRecord): void {
  d.workspaces = grid.workspaces;
  d.defaultWorkspaceId = grid.defaultWorkspaceId;
  if (grid.landing) applyListing(d, grid.landing.workspaceId, grid.landing.things, grid.landing.count);
}

/** Keeps the cache inside its bounds; the thing on screen (`pinned`) is never pruned. */
function close(d: Draft, pinned: string | null): EverythingsCache {
  const paged = Object.values(d.things)
    .filter(thing => thing.pageSeen > 0 && thing.id !== pinned)
    .sort((a, b) => b.pageSeen - a.pageSeen);
  const room = PAGES_KEPT - (pinned !== null && (d.things[pinned]?.pageSeen ?? 0) > 0 ? 1 : 0);
  for (const thing of paged.slice(Math.max(0, room))) {
    const { content: _c, isContentCut: _x, request: _r, marks: _m, children: _h, comments: _k, ...rest } = thing;
    d.things[thing.id] = { ...rest, pageSeen: 0, isPruned: true };
  }

  let excess = Object.keys(d.things).length - THINGS_MAX;
  if (excess > 0) {
    const oldest = Object.values(d.things)
      .filter(thing => thing.id !== pinned)
      .sort((a, b) => a.seen - b.seen);
    for (const thing of oldest) {
      if (excess <= 0) break;
      delete d.things[thing.id];
      excess -= 1;
    }
  }

  const orderKeys = Object.keys(d.order);
  for (const key of orderKeys.slice(0, Math.max(0, orderKeys.length - ORDERS_MAX))) delete d.order[key];
  for (const [key, listed] of Object.entries(d.order)) {
    if (listed.ids.length > ORDER_IDS_MAX) d.order[key] = { ids: listed.ids.slice(0, ORDER_IDS_MAX), count: listed.count };
  }

  const deleted = Object.entries(d.deleted)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DELETED_MAX);

  return {
    tick: d.tick,
    things: d.things,
    workspaces: d.workspaces.slice(0, WORKSPACES_MAX),
    defaultWorkspaceId: d.defaultWorkspaceId,
    order: d.order,
    deleted: Object.fromEntries(deleted),
    defaultMarks: Object.fromEntries(Object.entries(d.defaultMarks).slice(-WORKSPACES_MAX)),
    searches: Object.fromEntries(Object.entries(d.searches).slice(-SEARCHES_MAX)),
  };
}

function id(value: unknown): string | null {
  return str(value, 100);
}

/** Workspace names the search and recent listings carry beside each thing. */
function nameWorkspacesOf(d: Draft, items: unknown): void {
  for (const item of Array.isArray(items) ? items : []) {
    if (isRecord(item)) nameWorkspace(d, id(item.workspaceId), str(item.workspaceName));
  }
}

/**
 * A search_things answer: its hits go in as names and places, and, for a
 * query, the list of them in the server's order, as the latest search.
 */
function applySearch(d: Draft, query: string, r: Record<string, unknown>): void {
  const records = parseRefs(r.results);
  for (const record of records) put(d, record);
  nameWorkspacesOf(d, r.results);
  const key = searchKey(query);
  if (!key) return;
  const ids = records.map(record => record.id).filter(one => d.things[one] !== undefined);
  delete d.searches[key];
  d.searches[key] = { query, ids, count: Math.max(num(r.count, ids.length), ids.length) };
}

/** A new thing's page, from what create_thing or request_input was given. */
function created(thingId: string, args: Record<string, unknown>, extra: Partial<ThingRecord>): ThingRecord {
  const text = typeof args.content === 'string' ? args.content : '';
  return {
    id: thingId,
    name: str(args.name) ?? 'Untitled',
    emoji: str(args.emoji, 32),
    parentId: id(args.parentId),
    ...(id(args.workspaceId) ? { workspaceId: id(args.workspaceId) as string } : {}),
    // HTML is converted on the server, so its Markdown is unknown here.
    ...(looksLikeHtml(text) ? {} : parseContent(text)),
    marks: [],
    children: NO_CHILDREN,
    ...extra,
  };
}

/**
 * Records one answered Everythings call: the agent's, or the person's own
 * mark or comment from the pane. `data` is its JSON answer, null when
 * unreadable. `author` is who a comment it added shows as: the agent's
 * shows as SESSION_AUTHOR until a read brings the server's row, the
 * person's own as PERSON_AUTHOR.
 */
export function recordCall(
  cache: EverythingsCache,
  name: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | null,
  pinned: string | null,
  author = SESSION_AUTHOR,
): EverythingsCache {
  const d = open(cache);
  const r = data ?? {};
  const thingId = id(args.thingId);

  switch (name) {
    case 'get_thing_view': {
      const view = parseThingView(r);
      if (view) applyThingView(d, view);
      break;
    }
    case 'get_workspace_view': {
      const grid = parseGridView(r);
      if (grid) applyGrid(d, grid);
      break;
    }
    case 'get_thing': {
      const thing = parseThing(r);
      if (thing) put(d, thing);
      break;
    }
    case 'list_workspaces': {
      if (Array.isArray(r.workspaces)) d.workspaces = parseWorkspaces(r.workspaces);
      if ('defaultWorkspaceId' in r) d.defaultWorkspaceId = id(r.defaultWorkspaceId);
      break;
    }
    case 'get_workspace': {
      const workspaceId = id(r.id);
      nameWorkspace(d, workspaceId, str(r.name));
      const marks = parseDefaultMarks(r);
      if (workspaceId && marks) d.defaultMarks[workspaceId] = marks;
      break;
    }
    case 'list_things': {
      const workspaceId = id(args.workspaceId);
      const records = parseRefs(r.things);
      if (workspaceId) applyListing(d, workspaceId, records, num(r.count, records.length));
      break;
    }
    case 'list_child_things': {
      const parentId = id(args.parentId);
      if (!parentId) break;
      const { records, section } = parseChildren(r);
      for (const record of records) put(d, { ...record, parentId });
      put(d, { id: parentId, children: section });
      break;
    }
    case 'search_things':
      applySearch(d, typeof args.query === 'string' ? args.query : '', r);
      break;
    case 'recent_things':
      for (const record of parseRefs(r.things)) put(d, record);
      nameWorkspacesOf(d, r.things);
      break;
    case 'list_comments':
      if (thingId) put(d, { id: thingId, comments: parseComments(r) });
      break;
    case 'list_marks':
      if (thingId) put(d, { id: thingId, marks: parseMarks(r) });
      break;
    case 'create_thing': {
      const newId = id(r.thingId);
      if (!newId) break;
      put(d, created(newId, { ...args, workspaceId: r.workspaceId ?? args.workspaceId }, { request: null, comments: NO_COMMENTS }));
      const thing = d.things[newId];
      if (thing) attach(d, thing);
      break;
    }
    case 'update_thing': {
      const updatedId = id(r.thingId) ?? thingId;
      if (!updatedId) break;
      put(d, {
        id: updatedId,
        ...('name' in r && str(r.name) ? { name: str(r.name) as string } : {}),
        ...('emoji' in r ? { emoji: str(r.emoji, 32) } : {}),
        ...('content' in r ? parseContent(r.content) : {}),
      });
      break;
    }
    case 'delete_thing':
      if (thingId) remove(d, thingId);
      break;
    case 'restore_thing':
      if (thingId) delete d.deleted[thingId];
      break;
    case 'move_thing': {
      if (!thingId) break;
      const parentId = 'newParentId' in r ? id(r.newParentId) : id(args.newParentId);
      detach(d, thingId);
      put(d, { id: thingId, parentId });
      const thing = d.things[thingId];
      if (thing) attach(d, thing);
      break;
    }
    case 'copy_thing': {
      const copyId = id(r.thingId);
      if (!copyId) break;
      const source = thingId ? d.things[thingId] : undefined;
      const copy: ThingRecord = {
        id: copyId,
        name: str(r.name) ?? source?.name ?? 'Untitled',
        emoji: source?.emoji ?? null,
        parentId: id(args.targetParentId),
        ...(id(args.targetWorkspaceId) ? { workspaceId: id(args.targetWorkspaceId) as string } : {}),
        // A copy carries content, but no marks or comments.
        ...(source?.content !== undefined ? { content: source.content, isContentCut: source.isContentCut === true } : {}),
        marks: [],
        comments: NO_COMMENTS,
        ...(num(r.copiedCount, 0) === 1 ? { children: NO_CHILDREN } : {}),
      };
      put(d, copy);
      const thing = d.things[copyId];
      if (thing) attach(d, thing);
      break;
    }
    case 'add_mark': {
      // The call rides the person's token, so the mark is theirs after it,
      // "created" or "unchanged" alike. The count goes up only for a mark
      // the cache did not have as theirs: a read that came back while the
      // call ran may have counted it already.
      const markName = str(args.name, 100) ?? str(args.emoji, 32);
      const emoji = str(args.emoji, 32);
      const isCreated = r.action === 'created';
      if (!thingId || !markName || !emoji || (!isCreated && r.action !== 'unchanged')) break;
      if (isCreated) patchRow(d, thingId, markName, emoji, 1);
      patch(d, thingId, thing => {
        if (!thing.marks) return null;
        const known = thing.marks.find(mark => mark.name === markName);
        if (!known) return { ...thing, marks: [...thing.marks, { name: markName, emoji, count: 1, mine: true }] };
        if (known.mine) return null;
        return {
          ...thing,
          marks: thing.marks.map(mark =>
            mark.name === markName ? { ...mark, count: isCreated ? mark.count + 1 : mark.count, mine: true } : mark,
          ),
        };
      });
      break;
    }
    case 'remove_mark': {
      // The mark is not theirs after it, "deleted" or "unchanged" alike. The
      // count goes down only for a mark the cache still had as theirs.
      const markName = str(args.name, 100) ?? str(args.emoji, 32);
      const isDeleted = r.action === 'deleted';
      if (!thingId || !markName || (!isDeleted && r.action !== 'unchanged')) break;
      if (isDeleted) patchRow(d, thingId, markName, null, -1);
      patch(d, thingId, thing => {
        const known = thing.marks?.find(mark => mark.name === markName);
        if (!thing.marks || !known || !known.mine) return null;
        return {
          ...thing,
          marks: thing.marks
            .map(mark =>
              mark.name === markName ? { ...mark, count: isDeleted ? mark.count - 1 : mark.count, mine: false } : mark,
            )
            .filter(mark => mark.count > 0),
        };
      });
      break;
    }
    case 'add_comment': {
      const commentId = id(r.commentId);
      if (!thingId || !commentId) break;
      const text = commentText(args.content);
      patch(d, thingId, thing =>
        thing.comments
          ? {
              ...thing,
              comments: {
                ...thing.comments,
                list: [...thing.comments.list, { id: commentId, authorName: author, byAgent: null, parentId: null, text }],
                count: thing.comments.count + 1,
              },
            }
          : null,
      );
      break;
    }
    case 'request_input': {
      const askedId = id(r.thingId) ?? thingId;
      if (!askedId) break;
      // Without a thingId the call made a new thing to carry the question.
      if (!thingId) {
        put(d, created(askedId, args, {}));
        const thing = d.things[askedId];
        if (thing) attach(d, thing);
      }
      if (isRecord(r.request)) put(d, { id: askedId, request: parseRequest(r.request) });
      break;
    }
    case 'answer_request':
    case 'resolve_request':
      if (thingId && isRecord(r.request)) put(d, { id: thingId, request: parseRequest(r.request) });
      break;
    case 'resolve_mention': {
      const onThing = id(r.thingId);
      const commentId = id(r.commentId);
      const replyId = id(r.replyId);
      if (!onThing || !commentId || r.action !== 'resolved') break;
      patch(d, onThing, thing => {
        if (!thing.comments) return null;
        const list = thing.comments.list.map(comment =>
          comment.id === commentId ? { ...comment, text: comment.text.replace('@Agent', '🤖agent') } : comment,
        );
        const reply = replyId
          ? [{ id: replyId, authorName: SESSION_AUTHOR, byAgent: null, parentId: commentId, text: commentText(args.reply) }]
          : [];
        return { ...thing, comments: { ...thing.comments, list: [...list, ...reply], count: thing.comments.count + reply.length } };
      });
      break;
    }
    default:
      return cache;
  }
  return close(d, pinned);
}

/** The pane's own get_thing_view answer, read from tick `since` on. */
export function recordPage(cache: EverythingsCache, view: ThingViewRecord, since: number, pinned: string | null): EverythingsCache {
  const d = open(cache, since);
  applyThingView(d, view);
  return close(d, pinned);
}

/** A workspace's default marks, from the pane's own get_workspace answer. */
export function recordDefaultMarks(
  cache: EverythingsCache,
  workspaceId: string,
  marks: EverythingsDefaultMark[],
): EverythingsCache {
  const known = cache.defaultMarks[workspaceId];
  if (known && JSON.stringify(known) === JSON.stringify(marks)) return cache;
  return { ...cache, defaultMarks: { ...cache.defaultMarks, [workspaceId]: marks } };
}

/** The pane's own get_workspace_view answer, read from tick `since` on. */
export function recordGrid(cache: EverythingsCache, grid: GridRecord, since: number, pinned: string | null): EverythingsCache {
  const d = open(cache, since);
  applyGrid(d, grid);
  return close(d, pinned);
}

/** The pane's own search_things answer for `query`, read from tick `since` on. */
export function recordSearch(
  cache: EverythingsCache,
  query: string,
  data: Record<string, unknown>,
  since: number,
  pinned: string | null,
): EverythingsCache {
  const d = open(cache, since);
  applySearch(d, query, data);
  return close(d, pinned);
}

/**
 * The hits recorded for one query, recorded for another too: the agent ran
 * the search the pane asked for in its own words.
 */
export function aliasSearch(cache: EverythingsCache, from: string, to: string): EverythingsCache {
  const found = cache.searches[searchKey(from)];
  const key = searchKey(to);
  if (!found || !key || searchKey(from) === key) return cache;
  const { [key]: _old, ...rest } = cache.searches;
  return { ...cache, searches: { ...rest, [key]: found } };
}

/** A search's hits as known now; null while no answer for the query was recorded. */
export function searchOf(cache: EverythingsCache, query: string): DrawnSearch | null {
  const found = cache.searches[searchKey(query)];
  if (!found) return null;
  const hits: DrawnHit[] = found.ids.flatMap(one => {
    const thing = cache.things[one];
    if (!thing) return [];
    const workspace = thing.workspaceId ? cache.workspaces.find(ws => ws.id === thing.workspaceId) : undefined;
    return [
      {
        ...asRef(thing),
        workspaceId: thing.workspaceId ?? null,
        workspaceName: workspace?.name ?? null,
        marks: thing.rowMarks ?? null,
      },
    ];
  });
  return { query: found.query, hits, count: found.count, truncated: hits.length < found.count };
}

/** One thing's page as known now; null when the session has seen nothing of it. */
export function pageOf(cache: EverythingsCache, thingId: string): DrawnPage | null {
  const thing = cache.things[thingId];
  if (!thing) return null;
  const workspace = thing.workspaceId ? cache.workspaces.find(ws => ws.id === thing.workspaceId) : undefined;
  const parent = thing.parentId ? cache.things[thing.parentId] : undefined;
  const defaults = thing.workspaceId ? (cache.defaultMarks[thing.workspaceId] ?? null) : null;
  return fitPage(thing, workspace?.name ?? null, parent ? asRef(parent) : null, defaults, id => cache.things[id]?.rowMarks);
}

/**
 * True when the cache holds a thing's whole page, as a get_thing_view
 * answer leaves it: content and every section.
 */
export function isWholePage(cache: EverythingsCache, thingId: string): boolean {
  const thing = cache.things[thingId];
  return (
    thing !== undefined &&
    thing.content !== undefined &&
    thing.marks !== undefined &&
    thing.children !== undefined &&
    thing.comments !== undefined
  );
}

/** What a view draws from the cache, as one string: two caches that give the same draw the same. */
export function drawnOf(cache: EverythingsCache, view: EverythingsView): string {
  if (view.kind === 'search') return JSON.stringify(searchOf(cache, view.query));
  if (view.kind === 'inbox') return '';
  return JSON.stringify(view.kind === 'thing' ? pageOf(cache, view.thingId) : gridOf(cache, view.workspaceId));
}

/** The workspace a grid with none named lands on: the default, else the first known. */
export function landingOf(cache: EverythingsCache, workspaceId: string | null): string | null {
  if (workspaceId) return workspaceId;
  if (cache.defaultWorkspaceId) return cache.defaultWorkspaceId;
  if (cache.workspaces[0]) return cache.workspaces[0].id;
  const newest = Object.values(cache.things)
    .filter(thing => thing.workspaceId)
    .sort((a, b) => b.seen - a.seen)[0];
  return newest?.workspaceId ?? null;
}

/** A workspace's grid as known now: the listing's order first, then top-level things seen since. */
export function gridOf(cache: EverythingsCache, workspaceId: string | null): DrawnGrid {
  const landing = landingOf(cache, workspaceId);
  if (!landing) return fitGrid(cache.workspaces, null);
  const listed = cache.order[landing];
  const isTop = (thing: EverythingsCachedThing | undefined): thing is EverythingsCachedThing =>
    thing !== undefined && thing.workspaceId === landing && thing.parentId === null;
  const inOrder = (listed?.ids ?? []).map(one => cache.things[one]).filter(isTop);
  const placed = new Set(inOrder.map(thing => thing.id));
  const others = Object.values(cache.things)
    .filter(thing => isTop(thing) && !placed.has(thing.id))
    .sort((a, b) => a.seen - b.seen);
  const things: EverythingsThingRef[] = [...inOrder, ...others].map(asRef);
  return fitGrid(cache.workspaces, {
    workspaceId: landing,
    things,
    count: Math.max(listed?.count ?? 0, things.length),
    isListed: listed !== undefined,
  });
}
