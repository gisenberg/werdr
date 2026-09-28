import test from 'node:test';
import assert from 'node:assert/strict';
import { LastPane } from '../src/last-pane.ts';
import { emptySnapshot, type Snapshot } from '../shared/fleet.ts';
const snapshot = (): Snapshot => ({ ...emptySnapshot(),
  workspaces: ['a', 'b'].map(workspace_id => ({ workspace_id, label: '', agent_status: 'idle' })),
  tabs: ['a', 'b'].map(id => ({ workspace_id: id, tab_id: id, label: '' })),
  panes: ['a', 'b'].map(id => ({ workspace_id: id, tab_id: id, pane_id: id, terminal_id: `terminal-${id}`, agent_status: 'idle' })),
});
test('last pane toggles across workspaces and resolves current ancestry without recording redraws', () => {
  const history = new LastPane(), state = snapshot();
  history.observe('host', 'a', state); assert.equal(history.target('host', 'a', state), undefined);
  history.observe('host', 'b', state); history.observe('host', 'b', state);
  assert.equal(history.target('host', 'b', state)?.pane_id, 'a');
  history.observe('host', 'a', state); assert.equal(history.target('host', 'a', state)?.pane_id, 'b');
  state.panes[1].workspace_id = 'a'; state.panes[1].tab_id = 'a';
  assert.equal(history.target('host', 'a', state)?.workspace_id, 'a');
  state.panes.pop(); assert.equal(history.target('host', 'a', state), undefined);
});
test('last pane rejects pending selection, reused terminal IDs, unavailable hosts and connection replacements', () => {
  for (const change of ['previous-terminal', 'current-terminal', 'host', 'gateway', 'connection', 'offline', 'ancestry']) {
    const history = new LastPane(), state = snapshot();
    history.observe('scope', 'a', state); history.observe('scope', 'b', state);
    assert.equal(history.target('scope', 'pending', state), undefined);
    if (change === 'previous-terminal') state.panes[0].terminal_id = 'replacement';
    else if (change === 'current-terminal') state.panes[1].terminal_id = 'replacement';
    else if (change === 'ancestry') state.tabs = state.tabs.filter(tab => tab.tab_id !== 'a');
    else history.observe(change === 'offline' ? undefined : change, 'b', state);
    assert.equal(history.target('scope', 'b', state), undefined, change);
    if (change === 'current-terminal') { history.observe('scope', 'b', state); assert.equal(history.target('scope', 'b', state), undefined); }
  }
});

test('known boot history suspends through missing metadata and resumes only on an online snapshot', () => {
  const history = new LastPane(), state = snapshot();
  const context = { endpoint: 'host/session/platform', enabled: true, online: true, boot: 'boot-a', gateway: 'gateway-a', connection: 'connection-a' };
  let scope = history.connection(context);
  const staleScope = scope;
  history.observe(scope, 'a', state); history.observe(scope, 'b', state);
  for (const boot of ['boot-a', undefined, 'untrusted-offline-boot']) {
    scope = history.connection({ ...context, online: false, boot });
    history.observe(scope, 'a', state);
    assert.equal(history.target(scope, 'b', state), undefined);
    history.observe(staleScope, 'a', state);
    assert.equal(history.target(staleScope, 'b', state), undefined);
  }
  scope = history.connection({ ...context, gateway: 'gateway-b', connection: 'connection-b' });
  history.observe(scope, 'b', state);
  assert.equal(history.target(scope, 'b', state)?.pane_id, 'a');
});

test('reused pane identities cannot retain history after boot, endpoint, availability or capability replacement', () => {
  const state = snapshot();
  const context = { endpoint: 'host/session/platform', enabled: true, online: true, boot: 'boot-a', gateway: 'gateway-a', connection: 'connection-a' };
  for (const change of [{ boot: 'boot-b' }, { boot: undefined }, { boot: '' }, { boot: 'x'.repeat(257) }, { endpoint: 'other/session/platform' }, { enabled: false }, { endpoint: undefined }]) {
    const history = new LastPane(); let scope = history.connection(context);
    history.observe(scope, 'a', state); history.observe(scope, 'b', state);
    history.connection({ ...context, online: false });
    scope = history.connection({ ...context, ...change });
    history.observe(scope, 'b', state);
    assert.equal(history.target(scope, 'b', state), undefined, JSON.stringify(change));
  }
});

test('legacy reconnect remains conservative and independent viewers never share last-pane history', () => {
  const state = snapshot(), legacy = new LastPane(), viewer = new LastPane();
  const context = { endpoint: 'host', enabled: true, online: true, gateway: 'gateway', connection: 'connection' };
  let scope = legacy.connection(context);
  legacy.observe(scope, 'a', state); legacy.observe(scope, 'b', state);
  const viewerScope = viewer.connection({ ...context, boot: 'known' });
  viewer.observe(viewerScope, 'b', state); viewer.observe(viewerScope, 'a', state);
  legacy.connection({ ...context, online: false });
  scope = legacy.connection(context); legacy.observe(scope, 'b', state);
  assert.equal(legacy.target(scope, 'b', state), undefined);
  assert.equal(viewer.target(viewerScope, 'a', state)?.pane_id, 'b');
  viewer.reset(); assert.equal(viewer.target(viewerScope, 'a', state), undefined);
});
