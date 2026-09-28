import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundPlayer } from '../src/sound-player.ts';

class AudioFixture {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  paused = false; cleared = false; loaded = false;
  reject!: (error: unknown) => void;
  constructor(readonly source: string) {}
  play() { return new Promise<void>((_resolve, reject) => { this.reject = reject; }); }
  pause() { this.paused = true; } removeAttribute() { this.cleared = true; } load() { this.loaded = true; }
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
test('sound failures fall back exactly once and cancellation fences late errors and releases resources', async () => {
  const audio: AudioFixture[] = [], messages: string[] = [];
  const player = new SoundPlayer(message => messages.push(message), source => { const item = new AudioFixture(source); audio.push(item); return item as unknown as HTMLAudioElement; });
  player.play('/custom', '/builtin');
  audio[0].onerror!(); audio[0].reject(new Error('decode failed')); await tick();
  assert.deepEqual(audio.map(item => item.source), ['/custom', '/builtin']); assert.equal(messages.length, 1);
  assert.ok(audio[0].paused && audio[0].cleared && audio[0].loaded);
  audio[1].onerror!(); assert.equal(audio.length, 2); assert.equal(messages.length, 2);
  player.play('/another', '/builtin'); const late = audio[2].onerror!;
  player.stop(); late(); audio[2].reject(new Error('late error')); await tick();
  assert.equal(audio.length, 3); assert.equal(messages.length, 2);
  assert.ok(audio[2].paused && audio[2].cleared && audio[2].loaded);
  player.play('/new'); assert.equal(audio.length, 4); audio[3].onended!(); assert.equal(audio[3].paused, true);
});

test('browser permission rejection reports once without starting a doomed fallback', async () => {
  const audio: AudioFixture[] = [], messages: string[] = [];
  const player = new SoundPlayer(message => messages.push(message), source => { const item = new AudioFixture(source); audio.push(item); return item as unknown as HTMLAudioElement; });
  player.play('/custom', '/builtin'); audio[0].reject({ name: 'NotAllowedError' }); await tick();
  assert.equal(audio.length, 1); assert.match(messages[0], /Browser blocked audio/); assert.equal(audio[0].paused, true);
});
