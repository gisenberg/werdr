import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserAction } from '../server/browser-actions.ts';
import { readFile } from 'node:fs/promises';
test('every native integration target is supported without accepting arbitrary install arguments', async () => {
  const source = await readFile(new URL('../../src/api/schema/integrations.rs', import.meta.url), 'utf8');
  const targets = source.match(/pub enum IntegrationTarget \{([\s\S]*?)\}/)![1].split(',').map(value => value.trim()).filter(Boolean).map(value => value.replace(/[A-Z]/g, (letter, index) => (index ? '_' : '') + letter.toLowerCase()));
  for (const target of targets) for (const action of ['integration.install', 'integration.uninstall']) assert.deepEqual(browserAction({ action, target, command: 'ignored', path: '/ignored' }), { method: action, params: { target } });
  assert.deepEqual(browserAction({ action: 'integration.list', command: 'ignored' }), { method: 'integration.list', params: {} });
  assert.throws(() => browserAction({ action: 'integration.install', target: 'shell; bad' }));
});
