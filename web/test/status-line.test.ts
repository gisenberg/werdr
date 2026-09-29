import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from '../src/status-line.ts';

test('feedback survives summary refreshes and expires into the newest summary', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rendered: string[] = [], status = new StatusLine(text => rendered.push(text));
  status.update('Original host'); status.show('Save conflict');
  for (let i = 0; i < 20; i++) status.update('Updated host');
  assert.deepEqual(rendered, ['Original host', 'Save conflict']);
  context.mock.timers.tick(7999); assert.equal(rendered.at(-1), 'Save conflict');
  context.mock.timers.tick(1); assert.equal(rendered.at(-1), 'Updated host');
});
test('new feedback replaces its deadline and clearing context cancels pending expiry', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rendered: string[] = [], status = new StatusLine(text => rendered.push(text));
  status.update('Host A'); status.show('First'); context.mock.timers.tick(4000);
  status.show('Second'); context.mock.timers.tick(4000); assert.equal(rendered.at(-1), 'Second');
  status.update('Host B'); status.clear(); assert.equal(rendered.at(-1), 'Host B');
  status.show('Third'); context.mock.timers.tick(4000); assert.equal(rendered.at(-1), 'Third');
  context.mock.timers.tick(4000); assert.equal(rendered.at(-1), 'Host B');
});
