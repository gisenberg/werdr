import test from 'node:test';
import assert from 'node:assert/strict';
import { paneChrome, paneBorderLabel } from '../shared/pane-chrome.ts';
import { defaults } from '../shared/settings.ts';
import { geometry, type LayoutNode } from '../shared/layout.ts';
import type { Pane } from '../shared/fleet.ts';

const split: LayoutNode = { type: 'split', direction: 'right', ratio: .5, first: { type: 'pane', pane_id: 'left' }, second: { type: 'split', direction: 'down', ratio: .5, first: { type: 'pane', pane_id: 'top' }, second: { type: 'pane', pane_id: 'bottom' } } };
const none = { top: false, right: false, bottom: false, left: false };
const all = { top: true, right: true, bottom: true, left: true };
test('native shared borders keep only internal edges when outer borders are disabled', () => {
  const { panes } = geometry(split, 1000, 800, 0);
  const preferences = { ...defaults, paneGaps: false, paneOuterBorders: false };
  assert.deepEqual(paneChrome(panes.get('left')!, 1000, 800, true, preferences), none);
  assert.deepEqual(paneChrome(panes.get('top')!, 1000, 800, true, preferences), { ...none, left: true });
  assert.deepEqual(paneChrome(panes.get('bottom')!, 1000, 800, true, preferences), { ...none, left: true, top: true });
  assert.deepEqual(panes.get('bottom'), { x: 500, y: 400, width: 500, height: 400 });
});
test('independent borders, borderless panes and single/zoomed panes follow native rules', () => {
  const { panes } = geometry(split, 1005, 805);
  for (const pane of panes.values()) {
    assert.deepEqual(paneChrome(pane, 1005, 805, true, defaults), all);
    assert.deepEqual(paneChrome(pane, 1005, 805, true, { ...defaults, paneBorders: false }), none);
  }
  const rect = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(paneChrome(rect, 1000, 800, false, defaults), none);
  assert.deepEqual(paneChrome(rect, 1000, 800, true, defaults), all);
  assert.deepEqual(paneChrome(rect, 1000, 800, true, { ...defaults, paneOuterBorders: false }), none);
});
test('border labels prefer native presentation titles, then manual labels, then optional agent labels', () => {
  const pane: Pane = { pane_id: 'p', terminal_id: 't', workspace_id: 'w', tab_id: 'tab', agent_status: 'working', agent: 'codex', display_agent: 'reviewer' };
  assert.equal(paneBorderLabel(pane, defaults), '');
  assert.equal(paneBorderLabel(pane, { ...defaults, showAgentLabelsOnPaneBorders: true }), 'reviewer');
  assert.equal(paneBorderLabel({ ...pane, label: 'manual' }, defaults), 'manual');
  assert.equal(paneBorderLabel({ ...pane, title: 'native title', label: 'manual' }, defaults), 'native title');
});
