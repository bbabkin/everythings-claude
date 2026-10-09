// Push follow: the pane shows what this session's agent writes, the moment
// the write resolves. register.tsx hands every finished Everythings call
// here from its `tool.call` hook, after `next(e)` resolved and before it
// returns the result untouched. An Everythings call is told by its tool name
// after the last `__`, whatever the server is called in this session.

import type { ToolCallResult } from 'claude-code';

import { recordCall } from './cache';
import {
  answerData,
  FOLLOWED_WRITES,
  GENERIC_TOOLS,
  READ_ONLY_TOOLS,
  isAnswered,
  splitToolName,
  UNIQUE_TOOLS,
  writeTarget,
} from './data';
import { recordInboxCall, refreshInbox } from './inbox';
import { agentCompletedView, followWrite, forgetFresh, refreshView } from './nav';
import type { Ports } from './ports';
import { isLearnedServer, learnServer } from './server';

/**
 * A call of a tool only Everythings has names its server, which the pane
 * learns. A call of a tool name other servers use too (`search`,
 * `add_comment`) counts only on the server already learned, so a Notion
 * search never repoints the pane.
 *
 * Every Everythings call the agent makes goes into the session cache, so
 * the pane can draw what it carried with no read of its own: a new thing
 * from create_thing's input and result, new content from update_thing's
 * result, a whole page from get_thing_view. Then a followed write points the
 * pane at what it touched, and one read of the pane's own tries to complete
 * the page, unless Claude Code refuses the pane's reads (blocked.ts). That
 * read is left running, so the agent's call never waits on it, as are the
 * band's reads of its counts (inbox.ts), which follow every such call.
 */
export async function observeCall(
  p: Ports,
  tool: string,
  args: Record<string, unknown>,
  ran: ToolCallResult,
): Promise<void> {
  const parts = splitToolName(tool);
  if (!parts || !isAnswered(ran)) return;
  if (UNIQUE_TOOLS.has(parts.name)) await learnServer(p, parts.server);
  else if (!GENERIC_TOOLS.has(parts.name) || !(await isLearnedServer(p, parts.server))) return;

  const data = answerData(ran);
  const view = await p.view.read();
  const pinned = view.kind === 'thing' ? view.thingId : null;
  await p.cache.update(cache => recordCall(cache, parts.name, args, data, pinned));
  await agentCompletedView(p, parts.name, args, data);
  // The band's counts: what this call listed whole, then one read of each list it did not, left running.
  const listed = await recordInboxCall(p, parts.name, args, data);
  void refreshInbox(p, listed).catch(() => undefined);

  // Any write may have changed pages the cache cannot patch: none counts as fresh now.
  if (!READ_ONLY_TOOLS.has(parts.name)) await forgetFresh(p);
  if (!FOLLOWED_WRITES.has(parts.name)) return;
  const target = writeTarget(parts.name, args, data);
  if (!target) return;
  if (await followWrite(p, target)) void refreshView(p).catch(() => undefined);
}
