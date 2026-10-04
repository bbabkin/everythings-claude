// The model-callable tool `mcp__everythings__show_thing`: when the person
// asks to see a thing or a workspace, the model calls it and the pane opens
// on it, drawn from what this session has seen and completed by one read of
// the pane's own (none while Claude Code refuses the pane's reads). It
// writes nothing. Its answer tells the model what the pane shows: when the
// pane could not read the thing and the session knows no more than its
// name, the model's own get_thing_view call fills the pane (the hook records
// its result). register.tsx lists the tool at session start and serves its
// calls.

import type { ToolSpec } from 'claude-code';

import { gridOf, pageOf } from './cache';
import { openGrid, openThing, readSnapshot } from './nav';
import { NOT_CONNECTED } from './pane';
import type { Ports } from './ports';

export const SHOW_THING: ToolSpec = {
  name: 'show_thing',
  description:
    'Shows an Everythings thing or workspace to the person in the Everythings pane beside this conversation. ' +
    'Call it when the person asks to see, show or open a thing ("show me my music thing") or a workspace: ' +
    "pass the thing's id as thingId, or a workspace's id as workspaceId. With neither, the pane opens on " +
    "the person's default workspace. Calling it only displays; it changes no data. Its answer says what the pane " +
    'shows; when it says the pane could not load the thing, call get_thing_view (or get_workspace_view) ' +
    'yourself and the pane shows its result. To read a thing for yourself, call get_thing instead.',
  inputSchema: {
    type: 'object',
    properties: {
      thingId: { type: 'string', description: 'The thing to show' },
      workspaceId: { type: 'string', description: 'The workspace to show when no thing is named' },
    },
    additionalProperties: false,
  },
};

function id(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Said to the model while Claude Code refuses the pane's own reads. */
const BLOCKED = "Claude Code refuses the pane's own reads in this session.";

/** Opens the pane on what the call names; answers one line for the model. */
export async function showThing(p: Ports, args: Record<string, unknown>): Promise<string> {
  const thingId = id(args.thingId);
  const workspaceId = id(args.workspaceId);
  await p.openPane();
  if (thingId) await openThing(p, thingId);
  else await openGrid(p, workspaceId);

  const snap = await readSnapshot(p);
  const failure =
    snap.blocked !== null ? BLOCKED : (snap.load.error ?? (snap.load.isNotConnected ? NOT_CONNECTED : null));
  const why = snap.blocked !== null ? BLOCKED : `The pane's own read failed: ${failure}`;

  if (thingId) {
    const page = pageOf(snap.cache, thingId);
    // A page known only by name shows nothing the model could point the person to.
    const known = page !== null && !page.isNameOnly ? page : null;
    if (failure === null) return page ? `The Everythings pane shows "${page.name}".` : 'The Everythings pane is open.';
    if (known) {
      return `The Everythings pane shows "${known.name}" as this session's calls carried it; sections no call carried are missing. ${why}`;
    }
    return `The Everythings pane could not load it: ${failure} Call get_thing_view with thingId "${thingId}" yourself; the pane shows its result.`;
  }

  const grid = gridOf(snap.cache, snap.view.kind === 'grid' ? snap.view.workspaceId : workspaceId);
  const landing = grid.landing;
  const name = grid.workspaces.find(ws => ws.id === landing?.workspaceId)?.name ?? 'the';
  if (failure === null) return landing ? `The Everythings pane shows the "${name}" workspace.` : 'The Everythings pane is open.';
  if (landing && (landing.things.length > 0 || landing.isListed)) {
    return `The Everythings pane shows the things of the "${name}" workspace this session's calls carried. ${why}`;
  }
  const asked = workspaceId ? ` with workspaceId "${workspaceId}"` : '';
  return `The Everythings pane could not load it: ${failure} Call get_workspace_view${asked} yourself; the pane shows its result.`;
}
