// The everythings mod's contract: the values it keeps in `$.state` for the
// session, and their shapes. Every drawing (the pane today; a band and
// transcript rows later) reads these. hooks/nav.ts and hooks/follow.ts write
// them through hooks/cache.ts; hooks/server.ts keeps `server`, hooks/blocked.ts
// keeps `blocked` and `noteDismissed`, hooks/ask.ts keeps `asked`,
// hooks/writes.ts keeps `writes`.

/** Which screen the pane shows. A null workspace is the landing rules' pick. */
export type EverythingsView =
  | { kind: 'grid'; workspaceId: string | null }
  | { kind: 'thing'; thingId: string; workspaceId: string | null };

export type EverythingsWorkspace = { id: string; name: string; isDefault: boolean };

export type EverythingsThingRef = { id: string; name: string; emoji: string | null };

export type EverythingsAnswer = {
  optionId: string | null;
  optionLabel: string | null;
  comment: string | null;
  userName: string | null;
  via: string | null;
};

/** An agent's question on a thing (`thing.request`), shown read-only. */
export type EverythingsRequest = {
  question: string;
  options: { id: string; label: string; description: string | null }[];
  status: string;
  createdBy: string | null;
  answer: EverythingsAnswer | null;
};

/** A mark on a thing: how many carry it, and whether the person is among them. */
export type EverythingsMark = { name: string; emoji: string; count: number; mine: boolean };

/** One of a workspace's default marks, as get_workspace lists them. */
export type EverythingsDefaultMark = { name: string; emoji: string };

/** A mark as a list row draws it: name, emoji and how many carry it, with no `mine`. */
export type EverythingsRowMark = { name: string; emoji: string; count: number };

export type EverythingsComment = {
  id: string;
  authorName: string;
  byAgent: string | null;
  parentId: string | null;
  text: string;
};

export type EverythingsChildren = { things: EverythingsThingRef[]; count: number; truncated: boolean };

export type EverythingsComments = { list: EverythingsComment[]; count: number; truncated: boolean };

/**
 * What this session has seen of one thing, from the agent's own calls and
 * the pane's reads. A field left out is unknown, and the pane draws no
 * section for it.
 */
export type EverythingsCachedThing = {
  id: string;
  name: string;
  emoji: string | null;
  workspaceId?: string;
  /** Null at the top level of its workspace. */
  parentId?: string | null;
  /** GFM Markdown, at most 10,000 characters; null when the thing has none. */
  content?: string | null;
  isContentCut?: boolean;
  /** updatedByAgent, else createdByAgent; null when a person wrote it. */
  agent?: string | null;
  request?: EverythingsRequest | null;
  marks?: EverythingsMark[];
  children?: EverythingsChildren;
  comments?: EverythingsComments;
  /** The cache's tick when anything about it was last recorded. */
  seen: number;
  /** The tick when its content or a section was last recorded; 0 while only its name is known. */
  pageSeen: number;
  /** Its page was recorded once and then pruned to its name, to keep the cache in bounds. */
  isPruned?: true;
  /**
   * Its marks for a list row: from the freshest of a list read that carried
   * them (the view tools' sub-things and landing things), its page read, or
   * a mark write the session saw. At most 12. Absent while no call carried
   * them, which is unknown and stays distinct from none.
   */
  rowMarks?: EverythingsRowMark[];
};

/**
 * The session cache, bounded in hooks/cache.ts: at most 300 things, of which
 * the 8 whose pages were seen last keep content and sections.
 */
export type EverythingsCache = {
  /** Counts records up; each record stamps what it touched. */
  tick: number;
  things: Record<string, EverythingsCachedThing>;
  workspaces: EverythingsWorkspace[];
  defaultWorkspaceId: string | null;
  /** Top-level thing ids in the server's order, per workspace, from a listing, with the server's total. */
  order: Record<string, { ids: string[]; count: number }>;
  /** Things deleted in this session, with the tick of the delete. */
  deleted: Record<string, number>;
  /** Each workspace's default marks, once a get_workspace answer carried them. */
  defaultMarks: Record<string, EverythingsDefaultMark[]>;
};

/** The latest read the pane made: in flight, failed, or done. */
export type EverythingsLoad = {
  /** Counts reads up; a read records its answer only while it is still the latest. */
  seq: number;
  /** The view it was made for (see viewKey in hooks/data.ts). */
  key: string;
  isLoading: boolean;
  /** Why it failed, one line: the server's error; null when none. A refusal sets `blocked` instead. */
  error: string | null;
  /** True when no Everythings server answered at all. */
  isNotConnected: boolean;
};

/**
 * Claude Code refused the pane's own read, so the pane stops reading until
 * the person presses Refresh (hooks/blocked.ts).
 */
export type EverythingsBlocked = {
  /** The permission rules that let the pane's calls through, as Claude Code spells them: three for its reads, one or two for a write. */
  rules: string[];
  /** What the last press of the note's copy Button ("Copy the rules" or "Copy the rule") came to; null before one. */
  copy: 'copied' | 'failed' | null;
};

/**
 * The person's own writes from the pane (hooks/writes.ts): a mark on a
 * press, a comment on a submit. Nothing else on the pane writes.
 */
export type EverythingsWrites = {
  /**
   * Marks in flight, by `<thingId> <mark name>`, with the time (ms since the
   * epoch) the press sent each. A Button whose mark is in flight cannot fire
   * again; a marker older than 30 seconds, one an earlier load left, counts
   * for nothing.
   */
  pending: Record<string, number>;
  /** Comments in flight, by thing id, with the time each was sent; the same 30 seconds hold. */
  commenting: Record<string, number>;
  /** Comments posted from the pane, by thing id, so a post draws that thing a fresh, empty field. */
  posted: Record<string, number>;
  /** The last write that failed on a thing, with the server's text or the refusal. */
  error: { thingId: string; on: 'mark' | 'comment'; text: string } | null;
  /** Claude Code refused a write; the rules that let it through. */
  blocked: (EverythingsBlocked & { on: 'mark' | 'comment' }) | null;
  /**
   * The latest mark press on a thing, for the line under its marks: in
   * flight, done, or found as it already stood. Only the one latest is kept.
   */
  last: {
    thingId: string;
    name: string;
    emoji: string;
    did: 'adding' | 'removing' | 'added' | 'removed' | 'already-on' | 'already-off';
    /** When the press sent it; an "adding" or "removing" older than 30 seconds counts for nothing. */
    at: number;
  } | null;
};

declare module 'claude-code' {
  interface PluginState {
    everythings: {
      view: EverythingsView;
      /** Shaped: a reload whose code names another shape reads it as absent. */
      cache: Shaped<EverythingsCache>;
      load: EverythingsLoad;
      /** Push follow: on when /things runs, paused by a press on a thing, workspace or back. */
      follow: boolean;
      /** The MCP server name the pane's reads go to, for this session. */
      server: string | null;
      /** Set by a refused read, cleared by a read that succeeds; null while the pane may read. */
      blocked: EverythingsBlocked | null;
      /** The person dismissed the note about blocked reads (kept in `$.store` too); a refused Refresh clears it. */
      noteDismissed: boolean;
      /** The page the pane asked Claude to open (see askKey in hooks/ask.ts); null when none is pending. */
      asked: string | null;
      /**
       * When a read last filled each view, by view key (viewKey in hooks/data.ts),
       * in ms since the epoch; at most 30 seconds old. No drawing reads it.
       */
      fresh: Record<string, number>;
      /** Workspaces whose default marks the pane has asked for this session (at most once each). No drawing reads it. */
      defaultsAsked: string[];
      /** Shaped: a reload whose code names another shape reads it as absent. */
      writes: Shaped<EverythingsWrites>;
    };
  }
}
