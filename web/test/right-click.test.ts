import test from 'node:test';
import assert from 'node:assert/strict';
import { rightClickModifiers, rightClickRoute } from '../shared/right-click.ts';
import { browserAction } from '../server/browser-actions.ts';

test('right-click actions accept only explicit native routing targets and discard extra authority', () => {
  for (const right_click of ['pane', 'herdr']) assert.deepEqual(browserAction({ action: 'pane.input.set', id: 'w1:p1', right_click, command: 'ignored' }), { method: 'pane.input.set', params: { pane_id: 'w1:p1', right_click } });
  for (const right_click of [undefined, null, true, 'toggle', 'application']) assert.throws(() => browserAction({ action: 'pane.input.set', id: 'w1:p1', right_click }));
});

test('right-click routing matches exact browser chords and never takes Shift menu access', () => {
  for (const reporting of [false, true]) for (const paneOwns of [false, true]) for (const configured of rightClickModifiers) {
    for (let bits = 0; bits < 16; bits++) {
      const event = { ctrlKey: !!(bits & 1), altKey: !!(bits & 2), metaKey: !!(bits & 4), shiftKey: !!(bits & 8) };
      const held = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean).join('+');
      const expected = reporting && !event.shiftKey && (paneOwns && bits === 0 || !!configured && configured === held) ? 'pane' : 'menu';
      assert.equal(rightClickRoute(reporting, paneOwns, configured, event), expected, JSON.stringify({ reporting, paneOwns, configured, event }));
    }
  }
});
