import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { MAX_TERMINAL_INPUT_BYTES, splitTerminalInput, TERMINAL_INPUT_CHUNK_BYTES } from '../shared/terminal-input.ts';
import { INPUT_HIGH_WATER_BYTES, TerminalInputWriter } from '../server/terminal-input-writer.ts';
import { terminalInput } from '../server/policy.ts';

test('terminal input splits on code point boundaries within the message limit', () => {
  assert.deepEqual(splitTerminalInput(''), []);
  assert.deepEqual(splitTerminalInput('abc'), ['abc']);
  const text = 'a'.repeat(5) + '€😀'.repeat(20000) + '\x1b[201~';
  const chunks = splitTerminalInput(text);
  assert.equal(chunks.join(''), text);
  for (const [index, chunk] of chunks.entries()) {
    const bytes = Buffer.byteLength(chunk);
    assert.ok(bytes <= TERMINAL_INPUT_CHUNK_BYTES);
    // Only the final chunk may stop short of the next character boundary.
    if (index < chunks.length - 1) assert.ok(bytes > TERMINAL_INPUT_CHUNK_BYTES - 4);
    assert.doesNotThrow(() => terminalInput({ type: 'terminal.input', text: chunk }));
    assert.equal(Buffer.from(chunk).toString(), chunk, 'no chunk ends inside a surrogate pair');
  }
  assert.throws(() => terminalInput({ type: 'terminal.input', text: 'x'.repeat(MAX_TERMINAL_INPUT_BYTES + 1) }));
  assert.throws(() => splitTerminalInput('x', 3));
});

test('a slow controller pauses the viewer instead of rejecting queued input, then resumes after draining', async () => {
  const written: string[] = [], callbacks: (() => void)[] = [], pressure: boolean[] = [];
  const pipe = new Writable({ highWaterMark: 16384, write(chunk, _encoding, done) { written.push(chunk.toString()); callbacks.push(done); } });
  const writer = new TerminalInputWriter(pipe, paused => pressure.push(paused));
  const line = JSON.stringify({ type: 'terminal.input', text: 'x'.repeat(TERMINAL_INPUT_CHUNK_BYTES) }) + '\n';
  const lines = Math.ceil((INPUT_HIGH_WATER_BYTES * 3) / line.length);
  for (let index = 0; index < lines; index++) writer.write(line);
  assert.deepEqual(pressure, [true]);
  while (callbacks.length) { callbacks.shift()!(); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(pressure, [true, false]);
  assert.equal(written.join(''), line.repeat(lines));
  writer.dispose();
});
