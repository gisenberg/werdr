import test from 'node:test';
import assert from 'node:assert/strict';
import { customSoundFor, defaultCustomSounds, validateCustomSounds } from '../shared/custom-sounds.ts';

test('custom sound references preserve native event-over-global precedence without accepting paths or URLs', () => {
  const global = { id: 'a'.repeat(64), name: 'global.mp3' }, done = { id: 'b'.repeat(64), name: 'done.MP3' };
  const value = validateCustomSounds({ global, done });
  assert.deepEqual(customSoundFor(value, 'done'), done);
  assert.deepEqual(customSoundFor(value, 'request'), global);
  assert.equal(customSoundFor(defaultCustomSounds, 'done'), null);
  global.name = 'changed.mp3'; assert.equal(value.global?.name, 'global.mp3');
  for (const invalid of [null, [], { other: null }, { global: 'https://example.com/audio.mp3' }, { global: { id: '../secret', name: 'a.mp3' } }, { done: { ...done, name: '../a.mp3' } }, { done: { ...done, name: 'a.wav' } }, { done: { ...done, name: 'a\n.mp3' } }, { done: { ...done, path: '/secret' } }, { done: { ...done, name: 'x'.repeat(129) + '.mp3' } }]) assert.throws(() => validateCustomSounds(invalid));
});
