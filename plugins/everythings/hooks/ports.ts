// What the mod's logic may ask of the engine, as plain functions.
//
// The engine follows `$` only into functions declared in the same file as
// the hook that received it; `claude plugin validate` refuses a `$` handed
// to an imported function. So register.tsx holds every hook and builds a
// Ports from its `$` (the one place `$.mcp`, `$.store`, `$.ui` and
// `$.state` are spelled out), and the other files are logic written against
// this type.

import type { McpToolResult, RenderSurface } from 'claude-code';

import type {
  EverythingsBlocked,
  EverythingsCache,
  EverythingsInbox,
  EverythingsLoad,
  EverythingsView,
  EverythingsWake,
  EverythingsWrites,
} from '../types';

/** What `$.mcp.connect` answers: the name `$.mcp.call` takes, or why not. */
export type Connected = { isConnected: true; server: string } | { isConnected: false; message: string };

/** One value of the mod's `$.state`: read, or changed from what stands (answering the value written). */
export type Cell<T> = {
  read: () => Promise<T>;
  update: (change: (value: T) => T) => Promise<T>;
};

/** Equal values: the same one, or, for a small value, the same JSON. */
export function isSameJson<T>(a: T, b: T): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A Cell that skips a write which would leave the value as it stands. Every
 * write redraws the pane, and a redraw for nothing can replace the tree
 * under a second quick press. A skipped write is as if it ran at the read,
 * where the value already stood as the change would leave it.
 */
export function cellOf<T>(
  get: () => Promise<T>,
  put: (change: (value: T) => T) => Promise<T>,
  isSame: (a: T, b: T) => boolean = isSameJson,
): Cell<T> {
  return {
    read: get,
    update: async change => {
      const now = await get();
      return isSame(now, change(now)) ? now : put(change);
    },
  };
}

export type Ports = {
  view: Cell<EverythingsView>;
  cache: Cell<EverythingsCache>;
  load: Cell<EverythingsLoad>;
  follow: Cell<boolean>;
  server: Cell<string | null>;
  blocked: Cell<EverythingsBlocked | null>;
  noteDismissed: Cell<boolean>;
  asked: Cell<string | null>;
  fresh: Cell<Record<string, number>>;
  defaultsAsked: Cell<string[]>;
  writes: Cell<EverythingsWrites>;
  inbox: Cell<EverythingsInbox>;
  wake: Cell<EverythingsWake>;
  /** `$.clock.now()`: ms since the epoch. */
  now: () => Promise<number>;
  /** `$.mcp.call`: rejects when no server answers under that name. */
  mcpCall: (server: string, tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** `$.mcp.connect` on this plugin's own .mcp.json server. */
  mcpConnect: (server: string) => Promise<Connected>;
  storeGet: (key: string) => Promise<unknown>;
  storeSet: (key: string, value: unknown) => Promise<void>;
  /** Opens (or retitles) the pane. */
  openPane: () => Promise<void>;
  isPaneOpen: () => Promise<boolean>;
  /** `$.prompt.submit` as the person's own words: true once it entered, false when a hook dropped it. */
  askClaude: (text: string) => Promise<boolean>;
  /**
   * `$.prompt.submit` framed as the plugin's own message (not the person's
   * words): the wake on an answer. Resolves once the prompt's turn starts.
   */
  wakeSession: (text: string) => Promise<void>;
  /** `$.ui.copy` on the surface a press came from: true when the text reached a clipboard. */
  copy: (text: string, surface: RenderSurface) => Promise<boolean>;
};
