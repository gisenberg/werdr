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
