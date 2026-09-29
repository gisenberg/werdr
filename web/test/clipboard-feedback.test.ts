import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFeedbackRect } from '../src/clipboard-feedback.ts';

test('clipboard feedback anchors to all six native positions inside the terminal surface', () => {
  for (const vertical of ['top', 'bottom'] as const) for (const horizontal of ['left', 'center', 'right'] as const) {
    assert.deepEqual(clipboardFeedbackRect(800, 600, { width: 220, height: 60 }, `${vertical}-${horizontal}`), {
      x: horizontal === 'left' ? 0 : horizontal === 'center' ? 290 : 580,
      y: vertical === 'top' ? 0 : 540, width: 220, height: 60,
    });
  }
  assert.deepEqual(clipboardFeedbackRect(100, 30, { width: 220, height: 60 }, 'bottom-right'), { x: 0, y: 0, width: 100, height: 30 });
});

test('clipboard feedback moves away only from an intersecting notification and remains within the viewport', () => {
  const size = { width: 200, height: 60 };
  assert.equal(clipboardFeedbackRect(800, 600, size, 'top-right', { x: 500, y: 20, width: 300, height: 100 }).y, 120);
  assert.equal(clipboardFeedbackRect(800, 600, size, 'bottom-right', { x: 500, y: 500, width: 300, height: 100 }).y, 440);
  assert.equal(clipboardFeedbackRect(800, 600, size, 'bottom-left', { x: 500, y: 500, width: 300, height: 100 }).y, 540);
  assert.equal(clipboardFeedbackRect(800, 80, size, 'top-right', { x: 500, y: 0, width: 300, height: 80 }).y, 20);
});
