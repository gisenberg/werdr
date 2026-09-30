import test from 'node:test';
import assert from 'node:assert/strict';
import { characterTap, legacyChord } from '../src/terminal-keys.ts';

test('soft-keyboard characters map to the physical keys hardware keyboards report', () => {
  assert.deepEqual(characterTap('c'), { key: 'c', code: 'KeyC', shift: false });
  assert.deepEqual(characterTap('C'), { key: 'C', code: 'KeyC', shift: true });
  assert.deepEqual(characterTap('7'), { key: '7', code: 'Digit7' });
  assert.deepEqual(characterTap('['), { key: '[', code: 'BracketLeft', shift: false });
  assert.deepEqual(characterTap('_'), { key: '_', code: 'Minus', shift: true });
  assert.deepEqual(characterTap(' '), { key: ' ', code: 'Space', shift: false });
  assert.equal(characterTap('é'), undefined);
  assert.equal(characterTap('ab'), undefined);
  assert.equal(characterTap(''), undefined);
});

test('characters without a physical key fall back to legacy chord bytes', () => {
  assert.equal(legacyChord('é', { ctrl: false, alt: true }), '\x1bé');
  assert.equal(legacyChord('é', { ctrl: true, alt: false }), 'é');
  assert.equal(legacyChord('c', { ctrl: true, alt: false }), '\x03');
  assert.equal(legacyChord('c', { ctrl: true, alt: true }), '\x1b\x03');
  assert.equal(legacyChord('word', { ctrl: true, alt: false }), 'word');
});
