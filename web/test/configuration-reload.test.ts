import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationReload } from '../src/configuration-reload.ts';
import { ClientLifecycle } from '../src/client-lifecycle.ts';
import { browserAction } from '../server/browser-actions.ts';

test('reload uses the existing empty native method without forwarding configuration writes', () => {
  assert.deepEqual(browserAction({ action: 'server.reload_config', machine: 'selected', settings: { shell: 'ignored' }, id: 'unrelated' }), { method: 'server.reload_config', params: {} });
});

test('host and browser reloads run independently and report partial and failed outcomes', async () => {
  for (const scenario of ['partial', 'host failure', 'browser failure', 'preview', 'invalid response']) {
    const lifecycle = new ClientLifecycle(), reports: string[] = [], requests: unknown[] = [];
    let refreshed = false;
    const reload = new ConfigurationReload(async (path, data) => {
      requests.push({ path, data });
      if (scenario === 'host failure') throw new Error('Host unavailable');
      return scenario === 'invalid response' ? {} : { status: scenario === 'partial' ? 'partial' : 'applied', diagnostics: scenario === 'partial' ? ['Keep the existing terminal shell.'] : [] };
    }, async current => {
      assert.equal(current(), true); refreshed = true;
      if (scenario === 'browser failure') throw new Error('Preference read unavailable');
      return scenario !== 'preview';
    }, lifecycle, message => reports.push(message), () => {});
    await reload.run('original-host', 'Original host');
    assert.equal(refreshed, true); assert.equal(reload.busy, false);
    assert.deepEqual(requests, [{ path: '/api/action', data: { machine: 'original-host', action: 'server.reload_config' } }]);
    const result = reports.at(-1)!; assert.match(result, /Original host:/);
    if (scenario === 'partial') assert.match(result, /HOST \[WARN\].*BROWSER \[OK\].*Keep the existing terminal shell/);
    if (scenario === 'host failure') assert.match(result, /HOST \[ERROR\].*BROWSER \[OK\].*Host unavailable/);
    if (scenario === 'browser failure') assert.match(result, /HOST \[OK\].*BROWSER \[ERROR\].*Preference read unavailable/);
    if (scenario === 'preview') assert.match(result, /HOST \[OK\].*BROWSER \[WARN\].*preview preserved/);
    if (scenario === 'invalid response') assert.match(result, /HOST \[ERROR\].*Unexpected host reload response/);
  }
});

test('reload suppresses duplicates and detached results without blocking the resumed client', async () => {
  const lifecycle = new ClientLifecycle(), reports: string[] = [];
  const pending: (() => void)[] = [], guards: (() => boolean)[] = [];
  const reload = new ConfigurationReload(async () => { await new Promise<void>(resolve => pending.push(resolve)); return { status: 'applied', diagnostics: [] }; }, async current => { guards.push(current); return true; }, lifecycle, message => reports.push(message), () => {});
  const old = reload.run('a', 'Old'); assert.equal(reload.busy, true);
  await reload.run('a', 'Duplicate'); assert.equal(pending.length, 1);
  lifecycle.detach(); assert.equal(guards[0](), false); assert.equal(reload.busy, false);
  await reload.run('a', 'Detached'); assert.equal(pending.length, 1);
  lifecycle.resume(); const resumed = reload.run('b', 'Resumed'); assert.equal(pending.length, 2);
  pending[0](); await old; assert.equal(reload.busy, true); assert.equal(reports.length, 2);
  pending[1](); await resumed; assert.equal(reload.busy, false);
  assert.match(reports.at(-1)!, /^HOST \[OK\].*BROWSER \[OK\].*Resumed:/);
});
