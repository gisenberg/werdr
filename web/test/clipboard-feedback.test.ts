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

test('clipboard feedback steps past stacked pane notices and the native notification', () => {
  const size = { width: 200, height: 40 };
  const bar = { x: 0, y: 560, width: 800, height: 40 }, toast = { x: 250, y: 500, width: 300, height: 60 };
  assert.equal(clipboardFeedbackRect(800, 600, size, 'bottom-center', [bar]).y, 520);
  assert.equal(clipboardFeedbackRect(800, 600, size, 'bottom-center', [toast, bar]).y, 460);
  assert.equal(clipboardFeedbackRect(800, 600, size, 'top-center', [{ x: 0, y: 0, width: 800, height: 30 }, { x: 300, y: 30, width: 200, height: 50 }]).y, 80);
  assert.equal(clipboardFeedbackRect(800, 600, size, 'bottom-left', [{ x: 600, y: 560, width: 200, height: 40 }]).y, 560);
});
