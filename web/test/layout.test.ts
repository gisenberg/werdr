import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLayout } from '../server/layout.ts';
import { browserAction } from '../server/browser-actions.ts';
import { geometry } from '../shared/layout.ts';
const native = () => ({ layout: { workspace_id: 'workspace:1', tab_id: 'tab:1', zoomed: false, focused_pane_id: 'pane:1', root: { type: 'split', direction: 'right', ratio: .6, first: { type: 'pane', pane_id: 'pane:1', env: { SECRET: 'private' }, command: ['private-command'], cwd: '/private' }, second: { type: 'split', direction: 'down', ratio: .25, first: { type: 'pane', pane_id: 'pane:2' }, second: { type: 'pane', pane_id: 'pane:3' } } } } });
test('native layout exposes only identities and geometry, with exact nested divider paths', () => {
  const layout = browserLayout(native()); assert.doesNotMatch(JSON.stringify(layout), /private|SECRET|command|cwd/);
  const { panes, dividers } = geometry(layout.root, 1005, 805);
  assert.deepEqual(panes.get('pane:1'), { x: 0, y: 0, width: 600, height: 805 });
  assert.deepEqual(panes.get('pane:2'), { x: 605, y: 0, width: 400, height: 200 });
  assert.deepEqual(panes.get('pane:3'), { x: 605, y: 205, width: 400, height: 600 });
  assert.deepEqual(dividers.map(item => item.path), [[], [true]]);
});
test('malformed native layouts fail closed', () => {
  for (const ratio of [0, 1, NaN, Infinity, -.1]) { const value = native(); value.layout.root.ratio = ratio; assert.throws(() => browserLayout(value)); }
  const duplicate = native(); duplicate.layout.root.second.first.pane_id = 'pane:1'; assert.throws(() => browserLayout(duplicate));
  const focus = native(); focus.layout.focused_pane_id = 'pane:4'; assert.throws(() => browserLayout(focus));
});
test('layout mutations validate native parameters without forwarding extra authority', () => {
  assert.deepEqual(browserAction({ action: 'layout.set_split_ratio', id: 'tab:1', path: [true, false], ratio: .4, env: { SECRET: true } }), { method: 'layout.set_split_ratio', params: { tab_id: 'tab:1', path: [true, false], ratio: .4 } });
  for (const ratio of ['.5', NaN, Infinity, 0, 1]) assert.throws(() => browserAction({ action: 'layout.set_split_ratio', id: 'tab:1', path: [], ratio }));
  assert.throws(() => browserAction({ action: 'layout.set_split_ratio', id: 'tab:1', path: [1], ratio: .5 }));
  assert.throws(() => browserAction({ action: 'pane.move', id: 'pane:1', destination: 'shell', command: 'bad' }));
  assert.throws(() => browserAction({ action: 'pane.zoom', id: 'pane:1', mode: 'invalid' }));
  assert.throws(() => browserAction({ action: 'pane.swap', id: 'pane:1', direction: 'invalid' }));
  assert.throws(() => browserAction({ action: 'tab.move', id: 'tab:1', index: -1 }));
});
