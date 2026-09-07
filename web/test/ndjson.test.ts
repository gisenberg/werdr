import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonDecoder } from '../server/ndjson.ts';

test('terminal records survive every byte boundary without corrupting UTF-8 or ANSI payloads', () => {
  const frames = [{ type: 'terminal.frame', bytes: Buffer.from('\x1b[H羊🐑').toString('base64') }, { type: 'terminal.closed', reason: '羊🐑' }];
  const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new NdjsonDecoder(); const results: unknown[] = [];
    decoder.push(bytes.subarray(0, split), value => results.push(value));
    decoder.push(bytes.subarray(split), value => results.push(value));
    assert.deepEqual(results, frames);
  }
});
test('unterminated and terminated oversized records are rejected, while batches remain bounded per record', () => {
  assert.throws(() => new NdjsonDecoder(8).push(Buffer.from('123456789'), () => {}));
  assert.throws(() => new NdjsonDecoder(8).push(Buffer.from('123456789\n'), () => {}));
  assert.throws(() => new NdjsonDecoder().push(Buffer.from('invalid\n'), () => {}));
  const results: unknown[] = [];
  new NdjsonDecoder(2).push(Buffer.from('{}\n{}\n{}\n'), value => results.push(value));
  assert.equal(results.length, 3);
});
