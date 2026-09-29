import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavigatePreview } from '../src/navigate-preview.ts';

test('workspace preview wraps desktop rows and clamps mobile rows without changing actual selection', () => {
  const preview = new NavigatePreview();
  const actual = { machine: 'alpha', workspace: 'w2' };
  preview.enter(actual.machine, actual.workspace);
  preview.move(['w1', 'w2', 'w3'], 1, false);
  assert.deepEqual(preview.target, { machine: 'alpha', workspace: 'w3' });
  preview.move(['w1', 'w2', 'w3'], 1, false);
  assert.equal(preview.target?.workspace, 'w1');
  preview.move(['w1', 'w2', 'w3'], -1, false);
  assert.equal(preview.target?.workspace, 'w3');
  preview.move(['w1', 'w2', 'w3'], 1, true);
  assert.equal(preview.target?.workspace, 'w3');
  preview.enter('alpha', 'w1');
  preview.move(['w1', 'w2', 'w3'], -1, true);
  assert.equal(preview.target?.workspace, 'w1');
  assert.deepEqual(actual, { machine: 'alpha', workspace: 'w2' });
});

test('preview retains stable identity across reorder, hidden groups, removal, and host changes', () => {
  const preview = new NavigatePreview();
  preview.enter('alpha', 'w2');
  preview.reconcile('alpha', ['w3', 'w2', 'w1'], 'w1');
  assert.equal(preview.confirm(['w3', 'w2', 'w1'])?.workspace, 'w2');
  // A collapsed group does not invalidate the preview, but movement follows rendered rows.
  preview.move(['w1', 'w3'], 1, false);
  assert.equal(preview.target?.workspace, 'w3');
  preview.reconcile('alpha', ['w1', 'w2'], 'w2');
  assert.equal(preview.target?.workspace, 'w2');
  preview.reconcile('beta', ['w1', 'w2'], 'w2');
  assert.equal(preview.target, undefined);
  preview.move(['w1', 'w2'], 1, false);
  assert.equal(preview.confirm(['w1', 'w2']), undefined);
});

test('confirmation captures the preview before cancellation and rejects stale targets', () => {
  const preview = new NavigatePreview();
  preview.enter('alpha', 'w2');
  assert.equal(preview.confirm(['w1']), undefined);
  const target = preview.confirm(['w1', 'w2']);
  preview.clear();
  assert.deepEqual(target, { machine: 'alpha', workspace: 'w2' });
  assert.equal(preview.confirm(['w1', 'w2']), undefined);
});

test('native indexed workspace selection uses displayed order and leaves invalid digits in Navigate', () => {
  const preview = new NavigatePreview();
  preview.enter('alpha', 'w2');
  assert.deepEqual(preview.indexed(['w3', 'w1', 'w2'], 0), { machine: 'alpha', workspace: 'w3' });
  for (const invalid of [-1, 3, 9, 0.5, NaN]) assert.equal(preview.indexed(['w3', 'w1', 'w2'], invalid), undefined);
  assert.equal(preview.target?.workspace, 'w2');
  preview.reconcile('alpha', [], 'w2');
  preview.move([], 1, false);
  assert.equal(preview.confirm([]), undefined);
  preview.reconcile('alpha', ['new'], 'new');
  assert.equal(preview.target?.workspace, 'new');
});
