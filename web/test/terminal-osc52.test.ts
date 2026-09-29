import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeClipboardRequest, MAX_TERMINAL_CLIPBOARD_BYTES } from '../src/terminal-osc52.ts';

const encode = (value: string | Uint8Array) => Buffer.from(value).toString('base64');

test('terminal clipboard requests decode UTF-8 text, including empty clears', () => {
  assert.deepEqual(decodeClipboardRequest(encode('copied 東京 ✓')), { text: 'copied 東京 ✓' });
  assert.deepEqual(decodeClipboardRequest(''), { text: '' });
});

test('terminal clipboard requests enforce the byte limit before and after decoding', () => {
  assert.deepEqual(decodeClipboardRequest(encode(new Uint8Array(MAX_TERMINAL_CLIPBOARD_BYTES).fill(97))), { text: 'a'.repeat(MAX_TERMINAL_CLIPBOARD_BYTES) });
  assert.ok('error' in decodeClipboardRequest(encode(new Uint8Array(MAX_TERMINAL_CLIPBOARD_BYTES + 1))));
  assert.ok('error' in decodeClipboardRequest('A'.repeat(MAX_TERMINAL_CLIPBOARD_BYTES * 2)));
  assert.deepEqual(decodeClipboardRequest(encode('four'), 3), { error: 'Terminal clipboard request exceeds 1 MiB.' });
});

test('malformed terminal clipboard requests are rejected', () => {
  assert.ok('error' in decodeClipboardRequest('not base64!'));
  assert.ok('error' in decodeClipboardRequest(42));
  assert.ok('error' in decodeClipboardRequest(undefined));
});
