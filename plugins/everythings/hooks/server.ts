// Which MCP server the pane's reads go to.
//
// The same Everythings server runs under different names: a UUID for the
// claude.ai connector in the desktop app, `everythings` or
// `claude_ai_Everythings` in a terminal, `plugin_everythings_everythings`
// for this plugin's own .mcp.json entry. Reads try, in order: the name
// learned from an observed call (this session's, else the one kept in the
// store), then this plugin's own server through `$.mcp.connect`, then the
// claude.ai connector's display name. The first that answers is used for the
// rest of the session. Only a name learned from an observed call is kept in
// the store for later sessions.
//
// Claude Code may refuse the pane's own call: under auto permission mode it
// was seen refusing with "The server-side auto mode classifier gave no
// verdict ...". A refusal ends the read at once, with no other name tried
// and nothing retried; blocked.ts then stops the pane's reads until the
// person presses Refresh.

import type { McpToolResult } from 'claude-code';

import { oneLine } from './data';
import type { Ports } from './ports';

const STORE_KEY = 'server';
const OWN_SERVER = 'everythings';
const CLAUDE_AI_NAME = 'claude.ai Everythings';

/** No Everythings server answered. */
export class NotConnectedError extends Error {
  constructor() {
    super('The Everythings connector is not connected.');
    this.name = 'NotConnectedError';
  }
}

/** Claude Code refused the pane's call to `server`; the message is the engine's own words. */
export class RefusedError extends Error {
  constructor(
    readonly server: string,
    message: string,
  ) {
    super(message);
    this.name = 'RefusedError';
  }
}

/** The engine words a refusal `$.mcp.call(<server>, <tool>) refused: <reason>`. */
const REFUSED = /\brefused:/;

/** The server the session's reads go to, else the one kept from earlier sessions. */
export async function learnedServer(p: Ports): Promise<string | null> {
  const kept = await p.server.read();
  if (kept) return kept;
  const stored = await p.storeGet(STORE_KEY);
  return typeof stored === 'string' && stored ? stored : null;
}

/** True when `server` is the Everythings server already learned. */
export async function isLearnedServer(p: Ports, server: string): Promise<boolean> {
  return (await learnedServer(p)) === server;
}

/** An observed Everythings call named `server`: reads go there, now and in later sessions. */
export async function learnServer(p: Ports, server: string): Promise<void> {
  if ((await p.server.read()) !== server) await p.server.update(() => server);
  if ((await p.storeGet(STORE_KEY)) !== server) await p.storeSet(STORE_KEY, server);
}

/** What a rejected `$.mcp.call` says, without the engine's prefix. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return oneLine(text.replace(/^[\s\S]*?\$\.mcp\.call:\s*/, '')) || 'The Everythings server did not answer.';
}

/**
 * One call of a write tool, on the learned server only: the one this
 * session's reads or calls reached, else the one kept in the store from an
 * earlier session's calls. No other name is tried and nothing is retried. A refusal throws RefusedError; no learned server throws
 * NotConnectedError; any other rejection throws its reason.
 */
export async function callLearnedServer(
  p: Ports,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const server = await learnedServer(p);
  if (!server) throw new NotConnectedError();
  try {
    return await p.mcpCall(server, tool, args);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (REFUSED.test(text)) throw new RefusedError(server, text);
    throw new Error(reason(error));
  }
}

/**
 * Calls a read tool on the first Everythings server that answers. A refusal
 * throws RefusedError at once. When no server answers, it throws
 * NotConnectedError, or the error of the server this session had been
 * reading from, which says more than "not connected" does.
 */
export async function callEverythings(
  p: Ports,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const tried = new Set<string>();
  const session = await p.server.read();
  let sessionError: string | null = null;

  const attempt = async (server: string | null): Promise<McpToolResult | null> => {
    if (!server || tried.has(server)) return null;
    tried.add(server);
    try {
      const result = await p.mcpCall(server, tool, args);
      if (server !== session) await p.server.update(() => server);
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (REFUSED.test(text)) throw new RefusedError(server, text);
      if (server === session) sessionError = reason(error);
      return null;
    }
  };

  const first = await attempt(await learnedServer(p));
  if (first) return first;

  try {
    const own = await p.mcpConnect(OWN_SERVER);
    const answer = own.isConnected ? await attempt(own.server) : null;
    if (answer) return answer;
  } catch (error) {
    // A refusal ends the read; a connect that failed in any other way counts as no answer.
    if (error instanceof RefusedError) throw error;
  }

  const viaClaudeAi = await attempt(CLAUDE_AI_NAME);
  if (viaClaudeAi) return viaClaudeAi;

  if (sessionError !== null) throw new Error(sessionError);
  throw new NotConnectedError();
}
