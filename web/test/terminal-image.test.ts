import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { clipboardImageExtension, MAX_CLIPBOARD_IMAGE_BYTES } from '../shared/clipboard-image.ts';
import { TerminalInputWriter } from '../server/terminal-input-writer.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('image content detection ignores filenames and recognizes native image formats', () => {
  for (const [bytes, expected] of [[png, 'png'], [Buffer.from([255, 216, 255]), 'jpg'], [Buffer.from('GIF89a'), 'gif'], [Buffer.from('GIF87a'), 'gif'], [Buffer.from('RIFF0000WEBP'), 'webp'], [Buffer.from('BM'), 'bmp']] as const) assert.equal(clipboardImageExtension(bytes), expected);
  for (const bytes of [Buffer.from('image.png'), Buffer.from('RIFF0000WAVE'), png.subarray(0, 7), Buffer.alloc(0)]) assert.equal(clipboardImageExtension(bytes), undefined);
});

test('large image writes retain byte identity and keep following keystrokes ordered under backpressure', async () => {
  const records: any[] = []; let release!: () => void;
  const pipe = new Writable({ write(chunk, _encoding, done) { const record = JSON.parse(chunk.toString()); records.push(record); if (record.type === 'terminal.image') release = done; else done(); } });
  const writer = new TerminalInputWriter(pipe), bytes = Buffer.concat([png, Buffer.alloc(1024 * 1024, 123)]);
  const image = writer.image(bytes, MAX_CLIPBOARD_IMAGE_BYTES);
  writer.write('{"type":"terminal.input","text":"after"}\n');
  assert.equal(records.length, 1); assert.equal(records[0].extension, 'png'); assert.deepEqual(Buffer.from(records[0].bytes, 'base64'), bytes);
  assert.equal(records[0].target, undefined);
  await assert.rejects(writer.image(png, MAX_CLIPBOARD_IMAGE_BYTES), /still running/);
  release(); await image;
  assert.deepEqual(records[1], { type: 'terminal.input', text: 'after' });
});

test('image limits, queue bounds, transfer concurrency and disposal fail without forwarding another image', async () => {
  const callbacks: (() => void)[] = [], records: string[] = [];
  const writer = () => new TerminalInputWriter(new Writable({ write(chunk, _encoding, done) { records.push(chunk.toString()); callbacks.push(done); } }));
  const first = writer(), second = writer(), third = writer();
  await assert.rejects(first.image(png, 0), /updated terminal client/);
  await assert.rejects(first.image(Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1), MAX_CLIPBOARD_IMAGE_BYTES), /16 MiB/);
  await assert.rejects(first.image(Buffer.from('not an image'), MAX_CLIPBOARD_IMAGE_BYTES), /PNG/);
  assert.equal(records.length, 0);
  const one = first.image(png, MAX_CLIPBOARD_IMAGE_BYTES), two = second.image(png, MAX_CLIPBOARD_IMAGE_BYTES);
  await assert.rejects(third.image(png, MAX_CLIPBOARD_IMAGE_BYTES), /still running/);
  assert.throws(() => first.write('x'.repeat(65537)), /queue full/);
  first.write('{"type":"terminal.input","text":"discard"}\n'); first.dispose();
  const rejected = assert.rejects(one, /detached/); callbacks.shift()!(); callbacks.shift()!(); await rejected; await two;
  assert.equal(records.length, 2);
  const three = third.image(png, MAX_CLIPBOARD_IMAGE_BYTES); callbacks.shift()!(); await three;
});
