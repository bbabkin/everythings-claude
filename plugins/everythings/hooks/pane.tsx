// The pane's drawing: whichever screen the state names, from the session
// cache, as a tree of the surface's elements. It reads, and it writes two
// things, each only on the person's own action: their mark on a press of a
// mark Button, their comment on a submit of the comment field (writes.ts).
// Its other Buttons navigate, follow, refresh and retry, copy permission
// rules, dismiss a note, and ask Claude to open a page. An agent's question
// shows with its options and answer; the person answers it in the app. A
// section nobody has read yet is absent.
//
// register.tsx's `ui.render` hook calls drawPane with the surface's element
// table, a snapshot of the state, and the actions its presses run.

import type { ElementTable, RenderElement, RenderSurface } from 'claude-code';

import type {
  EverythingsBlocked,
  EverythingsDefaultMark,
  EverythingsRequest,
  EverythingsThingRef,
  EverythingsWrites,
} from '../types';
import { askClaude, askKey, type AskTarget } from './ask';
import { copyRules, dismissNote } from './blocked';
import { gridOf, pageOf } from './cache';
import {
  clip,
  NO_EMOJI,
  ROW_MARKS_SHOWN,
  thingIdFromLink,
  thingUrl,
  type DrawnChild,
  type DrawnGrid,
  type DrawnPage,
} from './data';
import {
  pressBack,
  pressRefresh,
  pressThing,
  pressWorkspace,
  toggleFollow,
  type PaneSnapshot,
} from './nav';
import type { Ports } from './ports';
import { dismissWriteNote, pressMark, submitComment, type MarkPress } from './writes';

/** What the pane's presses do. A press on a thing, a workspace or back pauses follow. */
export type PaneActions = {
  openThing: (thingId: string) => void;
  openWorkspace: (workspaceId: string) => void;
  back: () => void;
  toggleFollow: () => void;
  /** Refresh and Retry: one read, also while Claude Code refuses the pane's reads. */
  refresh: () => void;
  ask: (target: AskTarget) => void;
  copyRules: (on: 'reads' | 'writes', surface: RenderSurface) => void;
  dismissNote: () => void;
  dismissWriteNote: () => void;
  mark: (thingId: string, mark: MarkPress) => void;
  comment: (thingId: string, text: string) => void;
};

/** A press handler returns at once; its work runs on and never throws. */
function run(work: Promise<void>): void {
  void work.catch(() => undefined);
}

export function paneActions(p: Ports): PaneActions {
  return {
    openThing: thingId => run(pressThing(p, thingId)),
    openWorkspace: workspaceId => run(pressWorkspace(p, workspaceId)),
    back: () => run(pressBack(p)),
    toggleFollow: () => run(toggleFollow(p)),
    refresh: () => run(pressRefresh(p)),
    ask: target => run(askClaude(p, target)),
    copyRules: (on, surface) => run(copyRules(p, on, surface)),
    dismissNote: () => run(dismissNote(p)),
    dismissWriteNote: () => run(dismissWriteNote(p)),
    mark: (thingId, mark) => run(pressMark(p, thingId, mark)),
    comment: (thingId, text) => run(submitComment(p, thingId, text)),
  };
}

export const NOT_CONNECTED = 'The Everythings connector is not connected.';
/** Said beside a failed read when the screen holds what the session's calls carried. */
export const FROM_CALLS = "Showing what this session's calls carried.";
export const NOTHING_SEEN = 'Nothing from Everythings has been seen yet in this session.';
export const THING_NOT_SEEN = 'This thing has not been seen yet in this session.';
/** The note shown while Claude Code refuses the pane's reads. */
export const BLOCKED_NOTE =
  "Claude Code's permission mode blocks the pane's own reads, so the pane shows what Claude has read in this chat.";
export const UNBLOCK_HOW =
  "To let it read, allow these read-only tools in Claude Code's permission settings, then press Refresh:";
/** The note for a refused write; the line saying it was blocked sits where the person pressed. */
export const WRITE_UNBLOCK_HOW: Record<'mark' | 'comment', string> = {
  mark: "To allow marks from the pane, add these to Claude Code's permission settings:",
  comment: "To allow comments from the pane, add this to Claude Code's permission settings:",
};
export const NO_MARKS = 'No marks yet.';
export const THING_UNREAD = 'Claude has not read this thing in this chat yet.';
export const THING_PRUNED = 'The pane kept only the name of this thing, to save room.';
export const THING_ASKED = 'Asked Claude to open it. The page fills in once Claude reads it.';
export const WORKSPACE_UNLISTED = 'Claude has not listed this workspace in this chat yet.';
export const WORKSPACE_ASKED = 'Asked Claude to list it. The grid fills in once Claude lists it.';

/** The Button back to the workspace's grid: a grid of nine dots. */
export const GRID_GLYPH = '⋮⋮⋮';
const CHEVRON = '›';
/** A card's width in cells, border and padding included; the name gets the rest. */
const CARD_WIDTH = 18;
const CARD_NAME_CELLS = CARD_WIDTH - 4;
const PARENT_NAME_CELLS = 28;

/** A thing's emoji and name, with the apps' placeholder for a thing with no emoji. */
function label(emoji: string | null, name: string): string {
  return `${emoji ?? NO_EMOJI} ${name}`;
}

/** The copy Button's label: what it copies, then how the copy went (only ever shorter). */
function copyLabel(blocked: EverythingsBlocked): string {
  if (blocked.copy === 'copied') return 'Copied';
  if (blocked.copy === 'failed') return 'Copy failed';
  return blocked.rules.length === 1 ? 'Copy the rule' : 'Copy the rules';
}

export function drawPane(
  els: ElementTable,
  surface: RenderSurface,
  snap: PaneSnapshot,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = els;
  const { view, load, cache, blocked, writes } = snap;
  const page = view.kind === 'thing' ? pageOf(cache, view.thingId) : null;
  const grid = view.kind === 'grid' ? gridOf(cache, view.workspaceId) : null;
  const landing = grid?.landing ?? null;
  const hasData = page !== null || (landing !== null && (landing.things.length > 0 || landing.isListed));

  if (load.isNotConnected && !hasData) {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text>{NOT_CONNECTED}</Text>
        <Button key="retry" label="Retry" onPress={act.refresh} />
      </Box>
    );
  }

  const failure = load.error ?? (load.isNotConnected ? NOT_CONNECTED : null);
  const retry = <Button key="retry" label="Retry" onPress={act.refresh} />;
  // The pane will not fill this screen by itself: its reads are blocked, or the last one failed.
  const isSettled = blocked !== null || failure !== null;
  // Asking Claude helps then, as long as the connector answers.
  const canAsk = isSettled && !load.isNotConnected;
  const isAsked = snap.asked !== null && snap.asked === askKey(view, cache);
  // The reads' note, then a refused write's, both when both are up.
  const readNote = blocked !== null && !snap.isNoteDismissed ? blocked : null;
  const writeNote = writes.blocked;

  let unlisted: RenderElement | null = null;
  if (grid !== null && !hasData && canAsk) {
    const workspaceId = landing?.workspaceId ?? null;
    unlisted = drawAsk(els, {
      line: landing === null ? NOTHING_SEEN : WORKSPACE_UNLISTED,
      label: landing === null ? 'Ask Claude to show your workspace' : 'Ask Claude to list it',
      asked: WORKSPACE_ASKED,
      isAsked,
      onPress: () => act.ask({ kind: 'workspace', id: workspaceId }),
    });
  }

  // A read in flight shows on the Refresh Button, and a failed read's line
  // sits below the page: neither adds or drops a line above the cards, so
  // nothing moves under the pointer while a read runs.
  return (
    <Box flexDirection="column" rowGap={1}>
      {drawHeader(els, surface, snap, page, grid, act)}
      {readNote !== null && drawNote(els, [BLOCKED_NOTE, UNBLOCK_HOW], readNote, 'reads', act)}
      {writeNote !== null && drawNote(els, [WRITE_UNBLOCK_HOW[writeNote.on]], writeNote, 'writes', act)}
      {view.kind === 'thing' && !hasData && isSettled && <Text dimColor>{THING_NOT_SEEN}</Text>}
      {unlisted}
      {landing !== null && hasData && drawGrid(els, surface, landing, act)}
      {page !== null && drawThing(els, surface, page, writes, canAsk, isAsked, act)}
      {failure !== null && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{hasData ? `${FROM_CALLS} ${failure}` : failure}</Text>
          {retry}
        </Box>
      )}
    </Box>
  );
}

function drawHeader(
  els: ElementTable,
  surface: RenderSurface,
  snap: PaneSnapshot,
  page: DrawnPage | null,
  grid: DrawnGrid | null,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = els;
  const { view, cache, isFollowing } = snap;
  const workspaces = grid?.workspaces ?? cache.workspaces;
  const current = grid?.landing?.workspaceId ?? view.workspaceId;
  // The phone draws no Select (its table has none to draw), so it gets Buttons.
  const Select = surface !== 'mobile' && 'Select' in els ? els.Select : null;
  const picked = workspaces.some(ws => ws.id === current) ? (current ?? undefined) : undefined;

  let left: RenderElement | null = null;
  if (view.kind === 'thing') {
    // The breadcrumb: the workspace's grid, then the thing this one sits under.
    const parent = page?.parent ?? null;
    left = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="back" label={GRID_GLYPH} onPress={act.back} />
        {parent !== null && <Text dimColor>{CHEVRON}</Text>}
        {parent !== null && (
          <Button
            key="parent"
            label={label(parent.emoji, clip(parent.name, PARENT_NAME_CELLS))}
            onPress={() => act.openThing(parent.id)}
          />
        )}
      </Box>
    );
  } else if (workspaces.length > 0 && Select) {
    left = (
      <Select
        key="workspace"
        options={workspaces.map(ws => ({ value: ws.id, label: ws.name }))}
        value={picked}
        onSelect={act.openWorkspace}
      />
    );
  } else if (workspaces.length > 0) {
    left = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {workspaces.map(ws => (
          <Button
            key={`workspace:${ws.id}`}
            plain
            dimColor={ws.id !== current}
            label={ws.name}
            onPress={() => act.openWorkspace(ws.id)}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1}>{left}</Box>
      <Box flexDirection="row" columnGap={1}>
        <Button key="follow" label={isFollowing ? 'Follow: on' : 'Follow: paused'} onPress={act.toggleFollow} />
        <Button key="refresh" label={snap.load.isLoading ? 'Loading…' : 'Refresh'} onPress={act.refresh} />
      </Box>
    </Box>
  );
}

/**
 * Why Claude Code stopped a read or a write, and the permission rules that
 * let it through, which a Button copies. How the copy went shows in that
 * Button's label, which only gets shorter, so the note never grows a line.
 * The reads' note, dismissed, stays hidden until a Refresh the person
 * presses is refused; a write's goes until the next refused write.
 */
function drawNote(
  els: ElementTable,
  lines: string[],
  blocked: EverythingsBlocked,
  on: 'reads' | 'writes',
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = els;
  const prefix = on === 'reads' ? '' : 'write-';
  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <Text dimColor>{line}</Text>
      ))}
      {blocked.rules.map(rule => (
        <Text>{rule}</Text>
      ))}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button
          key={`copy-${prefix}rules`}
          label={copyLabel(blocked)}
          onPress={press => act.copyRules(on, press.surface)}
        />
        <Button
          key={`dismiss-${prefix}note`}
          label="Dismiss"
          onPress={on === 'reads' ? act.dismissNote : act.dismissWriteNote}
        />
      </Box>
    </Box>
  );
}

/** A page known only by name: why, and a Button asking Claude to open it, or the line saying it asked. */
function drawAsk(
  els: ElementTable,
  ask: { line: string; label: string; asked: string; isAsked: boolean; onPress: () => void },
): RenderElement {
  const { Box, Text, Button } = els;
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>{ask.line}</Text>
      {ask.isAsked ? (
        <Text dimColor>{ask.asked}</Text>
      ) : (
        <Box flexDirection="row">
          <Button key="ask" variant="primary" label={ask.label} onPress={ask.onPress} />
        </Box>
      )}
    </Box>
  );
}

/**
 * A workspace's things as cards of one width that wrap into aligned
 * columns, the emoji on its own line and the name below it cut to fit. Only
 * a Button takes a press, so off the terminal each card is one Button, its
 * label the emoji and the name on two lines. On the terminal the card is a
 * bordered Box whose border lights under the pointer, and the name is the
 * Button.
 */
function drawCards(
  els: ElementTable,
  surface: RenderSurface,
  refs: EverythingsThingRef[],
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = els;
  const isTerminal = surface === 'terminal';
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={isTerminal ? 0 : 1}>
      {refs.map(ref => {
        const emoji = ref.emoji ?? NO_EMOJI;
        const name = clip(ref.name, CARD_NAME_CELLS);
        const open = () => act.openThing(ref.id);
        return isTerminal ? (
          <Box
            key={`card:${ref.id}`}
            flexDirection="column"
            alignItems="center"
            width={CARD_WIDTH}
            paddingX={1}
            borderStyle="round"
            borderDimColor
            hover={{ borderColor: 'cyan', borderDimColor: false }}
          >
            <Text>{emoji}</Text>
            <Button key={`tile:${ref.id}`} plain label={name} onPress={open} />
          </Box>
        ) : (
          <Box key={`card:${ref.id}`} flexDirection="column" alignItems="stretch" width={CARD_WIDTH}>
            <Button key={`tile:${ref.id}`} label={`${emoji}\n${name}`} onPress={open} />
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * A sub-thing's row label: its marks' emojis when it carries any, then a
 * pipe, then its emoji and name in full (`✅ ⚠️ | 📄 Name`). The emojis follow
 * the mark row's order (the workspace's default marks in their order, then
 * the others), at most ROW_MARKS_SHOWN and then "+n". Marks unknown or none:
 * the emoji and name alone.
 */
function rowLabel(child: DrawnChild, defaults: EverythingsDefaultMark[] | null): string {
  const named = label(child.emoji, child.name);
  if (!child.marks || child.marks.length === 0) return named;
  const order = new Map((defaults ?? []).map((mark, index) => [mark.name, index]));
  const sorted = [
    ...child.marks
      .filter(mark => order.has(mark.name))
      .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0)),
    ...child.marks.filter(mark => !order.has(mark.name)),
  ];
  const shown = sorted
    .slice(0, ROW_MARKS_SHOWN)
    .map(mark => mark.emoji)
    .join(' ');
  const more = sorted.length - ROW_MARKS_SHOWN;
  return `${shown}${more > 0 ? ` +${more}` : ''} | ${named}`;
}

/**
 * A thing's sub-things as a list, one per row with a blank row between, so
 * each whole name shows. Each row is one Button stretched to the pane's
 * width, so the whole row takes the press. Off the terminal it is the
 * surface's filled button, which sets each row on its own background; the
 * terminal draws it plain. Its top padding and the page's gap before it
 * leave two blank rows above the list.
 */
function drawRows(
  els: ElementTable,
  surface: RenderSurface,
  children: DrawnChild[],
  defaults: EverythingsDefaultMark[] | null,
  act: PaneActions,
): RenderElement {
  const { Box, Button } = els;
  return (
    <Box key="sub-things" flexDirection="column" alignItems="stretch" rowGap={1} paddingTop={1}>
      {children.map(child =>
        surface === 'terminal' ? (
          <Button
            key={`child:${child.id}`}
            plain
            label={rowLabel(child, defaults)}
            onPress={() => act.openThing(child.id)}
          />
        ) : (
          <Button
            key={`child:${child.id}`}
            label={rowLabel(child, defaults)}
            onPress={() => act.openThing(child.id)}
          />
        ),
      )}
    </Box>
  );
}

function drawGrid(
  els: ElementTable,
  surface: RenderSurface,
  landing: NonNullable<DrawnGrid['landing']>,
  act: PaneActions,
): RenderElement {
  const { Box, Text } = els;
  if (landing.things.length === 0) return <Text dimColor>This workspace is empty.</Text>;
  return (
    <Box flexDirection="column">
      {drawCards(els, surface, landing.things, act)}
      {landing.truncated && <Text dimColor>{`Showing ${landing.things.length} of ${landing.count}.`}</Text>}
    </Box>
  );
}

/** What the line under the marks says about the latest press on this thing. */
function markLine(last: NonNullable<EverythingsWrites['last']>): string {
  const mark = `${last.emoji} ${last.name}`;
  switch (last.did) {
    case 'adding':
      return `Adding ${mark}…`;
    case 'removing':
      return `Removing ${mark}…`;
    case 'added':
      return `Added your ${mark} mark.`;
    case 'removed':
      return `Removed your ${mark} mark.`;
    case 'already-on':
      return `${mark} was already on.`;
    case 'already-off':
      return `${mark} was already off.`;
  }
}

/**
 * The thing's marks as one row of Buttons in a fixed order: the
 * workspace's default marks in their own order, carried or not, then the
 * marks it carries that are not among them (the carried marks alone while
 * the defaults are unknown). A press toggles the person's own mark and
 * changes that Button's label where it sits, so nothing moves under the
 * pointer. The label is the emoji, then the count when the thing carries
 * it; the person's own mark is primary and one nobody carries is dim. A
 * Button whose call is in flight draws dim and does nothing. Under the row, one dim line: a failure or a
 * refusal, else what the latest press did, else "No marks yet." on a thing
 * that carries none.
 */
function drawMarks(els: ElementTable, page: DrawnPage, writes: EverythingsWrites, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els;
  const carried = page.marks ?? [];
  const byName = new Map(carried.map(mark => [mark.name, mark]));
  const defaults = page.defaultMarks ?? [];
  const isDefault = new Set(defaults.map(mark => mark.name));
  const row = [
    ...defaults.map(mark => byName.get(mark.name) ?? { name: mark.name, emoji: mark.emoji, count: 0, mine: false }),
    ...carried.filter(mark => !isDefault.has(mark.name)),
  ];
  const error = writes.error?.thingId === page.id && writes.error.on === 'mark' ? writes.error.text : null;
  const last = writes.last?.thingId === page.id ? writes.last : null;
  const line = error ?? (last !== null ? markLine(last) : carried.length === 0 ? NO_MARKS : null);
  const isPending = (name: string) => writes.pending[`${page.id} ${name}`] !== undefined;
  return (
    <Box flexDirection="column">
      {row.length > 0 && (
        <Box key="marks" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {row.map(mark => {
            const label = `${mark.emoji}${mark.count > 0 ? ` ${mark.count}` : ''}`;
            const press = () => act.mark(page.id, { name: mark.name, emoji: mark.emoji });
            const isDim = isPending(mark.name) || mark.count === 0 || undefined;
            return mark.mine ? (
              <Button key={`mark:${mark.name}`} variant="primary" dimColor={isDim} label={label} onPress={press} />
            ) : (
              <Button key={`mark:${mark.name}`} plain dimColor={isDim} label={label} onPress={press} />
            );
          })}
        </Box>
      )}
      {line !== null && <Text dimColor>{line}</Text>}
    </Box>
  );
}

/**
 * The comments, then a field for the person's own comment, top level and
 * sent as typed. Each comment posted draws that thing a fresh field (its
 * key counts the thing's posts), so it comes back empty; a failure leaves
 * the field as typed, with its line under it. The
 * phone's table has no field to draw, so it shows the comments alone.
 */
function drawComments(
  els: ElementTable,
  surface: RenderSurface,
  page: DrawnPage,
  writes: EverythingsWrites,
  act: PaneActions,
): RenderElement | null {
  const { Box, Text } = els;
  const comments = page.comments;
  if (comments === null) return null;
  const Input = surface !== 'mobile' && 'Input' in els ? els.Input : null;
  const error = writes.error?.thingId === page.id && writes.error.on === 'comment' ? writes.error.text : null;
  if (comments.list.length === 0 && Input === null) return null;
  return (
    <Box flexDirection="column" rowGap={1}>
      {comments.list.length > 0 && <Text dimColor>{`Comments (${comments.count})`}</Text>}
      {comments.list.map(comment => (
        <Box flexDirection="column" paddingLeft={comment.parentId !== null ? 2 : 0}>
          <Box flexDirection="row" columnGap={1}>
            <Text bold>{comment.authorName}</Text>
            {comment.byAgent !== null && <Text dimColor>{`via ${comment.byAgent}`}</Text>}
          </Box>
          {comment.text !== '' && <Text>{comment.text}</Text>}
        </Box>
      ))}
      {comments.truncated && <Text dimColor>More comments in the app.</Text>}
      {/* Two blank rows above the field: the gap before it, and this padding. */}
      {Input !== null && (
        <Box flexDirection="column" paddingTop={1}>
          <Input
            key={`comment:${page.id}:${writes.posted[page.id] ?? 0}`}
            placeholder="Add a comment"
            submitLabel={writes.commenting[page.id] !== undefined ? 'sending…' : 'send'}
            onSubmit={text => act.comment(page.id, text)}
          />
          {error !== null && <Text dimColor>{error}</Text>}
        </Box>
      )}
    </Box>
  );
}

function drawThing(
  els: ElementTable,
  surface: RenderSurface,
  page: DrawnPage,
  writes: EverythingsWrites,
  canAsk: boolean,
  isAsked: boolean,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Link, Markdown } = els;
  const { children, content, links } = page;

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="column">
        <Text bold>{label(page.emoji, page.name)}</Text>
        {page.agent !== null && <Text dimColor>{`by ${page.agent}`}</Text>}
        {page.workspaceId !== null && <Link href={thingUrl(page.workspaceId, page.id)} label="Open in app" />}
      </Box>
      {page.marks !== null && drawMarks(els, page, writes, act)}
      {page.isNameOnly &&
        canAsk &&
        drawAsk(els, {
          line: page.isPruned ? THING_PRUNED : THING_UNREAD,
          label: 'Ask Claude to open it',
          asked: THING_ASKED,
          isAsked,
          onPress: () => act.ask({ kind: 'thing', id: page.id }),
        })}
      {content !== null &&
        (links.length > 0 ? (
          // Links to other things open them here; every other link opens as usual.
          <Markdown
            key="content"
            text={content}
            pressableLinks={links}
            onLinkPress={link => {
              const linked = thingIdFromLink(link.href);
              if (linked) act.openThing(linked);
            }}
          />
        ) : (
          <Markdown key="content" text={content} />
        ))}
      {page.isContentCut && <Text dimColor>Cut at 10,000 characters. Open it in the app for the rest.</Text>}
      {page.request !== null && drawRequest(els, page.request)}
      {children !== null && children.things.length > 0 && (
        <Box flexDirection="column">
          {drawRows(els, surface, children.things, page.defaultMarks, act)}
          {children.truncated && (
            <Text dimColor>{`Showing ${children.things.length} of ${children.count}.`}</Text>
          )}
        </Box>
      )}
      {drawComments(els, surface, page, writes, act)}
    </Box>
  );
}

const VIA: Record<string, string> = { web: 'on the web', mobile: 'on the phone', mcp: 'in a chat' };

/**
 * Shown for the person to read, with nothing to press, on purpose: the pane
 * writes with the agent's own token, so an answer sent from here would be
 * indistinguishable from the agent answering its own question. The person
 * answers in the app.
 */
function drawRequest(els: ElementTable, request: EverythingsRequest): RenderElement {
  const { Box, Text } = els;
  const answer = request.answer;
  const chosen = answer?.optionId ?? null;
  const by = [answer?.userName ? `by ${answer.userName}` : '', answer?.via ? (VIA[answer.via] ?? '') : '']
    .filter(Boolean)
    .join(' ');
  const answered = answer
    ? `Answered${answer.optionLabel ? `: ${answer.optionLabel}` : ''}` +
      `${answer.comment ? ` "${answer.comment}"` : ''}${by ? ` (${by})` : ''}`
    : null;
  return (
    <Box flexDirection="column">
      <Text bold>{request.createdBy ? `Question from ${request.createdBy}` : 'Question'}</Text>
      <Text>{request.question}</Text>
      {request.options.map(option => (
        <Text dimColor={chosen !== null && option.id !== chosen}>
          {`${option.id === chosen ? '✓' : '•'} ${option.label}${option.description ? `: ${option.description}` : ''}`}
        </Text>
      ))}
      {answered !== null && <Text>{answered}</Text>}
      {answer === null && request.status === 'open' && <Text dimColor>Waiting for an answer in the app.</Text>}
      {answer === null && request.status === 'dismissed' && <Text dimColor>Dismissed.</Text>}
    </Box>
  );
}
