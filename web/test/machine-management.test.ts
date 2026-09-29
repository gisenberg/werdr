import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('onboarding preserves catalog and owner boundaries through compatibility checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werdr-onboarding-test-'));
  const catalog = join(root, 'state/herdr/client/endpoints.json'), platforms = join(root, 'platforms.json');
  const original = { id: '11111111111111111111111111111111', target: 'unrelated.invalid', session: 'original', label: 'Existing host', enabled: false };
  const saved = JSON.stringify({ version: 1, ssh: [original] });
  const prior = { ...process.env };
  await mkdir(join(root, 'bin')); await mkdir(join(root, 'state/herdr/client'), { recursive: true });
  for (const name of ['herdr', 'ssh']) {
    await copyFile(new URL('./fixtures/onboarding-process.mjs', import.meta.url), join(root, 'bin', name));
    await chmod(join(root, 'bin', name), 0o700);
  }
  process.env.PATH = join(root, 'bin') + ':' + process.env.PATH;
  process.env.WERDR_HERDR_BIN = join(root, 'bin/herdr');
  process.env.WERDR_ONBOARDING_TEST_ROOT = root;
  process.env.XDG_STATE_HOME = join(root, 'state');
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    await rm(root, { recursive: true, force: true });
  });
  const { MachineManagement } = await import('../server/machine-management.ts');
  const { savePlatform, forgetPlatform } = await import('../server/machine-platforms.ts');
  const wait = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 5000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Onboarding fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const ready = { running: true, compatible: true, endpoint_compatible: true };
  for (const scenarioMode of [
    'ready', 'decline', 'install-ready', 'install-unready', 'install-failed', 'repair-install-ready', 'repair-install-unready',
    'cancel-probe', 'cancel-unready-probe', 'revoke-probe', 'stop-probe',
    'posix-ready', 'posix-decline', 'posix-failed', 'posix-repair-ready', 'posix-repair-failed',
    'posix-repair-failed-saved', 'posix-repair-cancel-saved', 'posix-repair-revoke-saved', 'posix-repair-stop-saved',
    'posix-failed-saved', 'posix-cancel-saved', 'posix-revoke-saved', 'posix-stop-saved',
    'posix-rename-cancel', 'posix-rename-revoke', 'posix-rename-stop', 'posix-rename-error', 'posix-rename-failed', 'posix-rename-external',
    'platform-cancel', 'platform-stop', 'posix-platform-cancel', 'posix-platform-stop',
  ] as const) await t.test(scenarioMode, async () => {
    const posix = scenarioMode.startsWith('posix-'), mode = posix ? scenarioMode.slice(6) : scenarioMode;
    for (const name of ['status-started', 'status-release', 'native-saved', 'rename-started', 'rename-release', 'platforms.json', 'calls.jsonl', 'installer-staged', 'installer-finished']) await rm(join(root, name), { force: true });
    const repairing = mode.startsWith('repair-');
    const record = repairing ? { ...original, target: 'onboarding.invalid' } : original;
    let savedCase = repairing ? JSON.stringify({ version: 1, ssh: [record] }) : saved;
    await writeFile(catalog, savedCase, { mode: 0o600 });
    process.env.WERDR_WINDOWS_MACHINES = posix ? '' : original.id;
    const installing = mode.includes('install-'), succeeds = mode === 'ready' || mode.endsWith('install-ready') || mode === 'repair-ready' || mode.startsWith('platform-') || (mode.startsWith('rename-') && !['rename-failed', 'rename-external'].includes(mode));
    const incompatible = { ...ready, endpoint_compatible: false };
    await writeFile(join(root, 'scenario.json'), JSON.stringify({ posix: posix ? mode.replace('repair-', '') : undefined, hold: mode.endsWith('probe'), server: mode === 'decline' || mode === 'cancel-unready-probe' || installing ? incompatible : ready, install: installing ? mode.split('install-')[1] : undefined, afterInstall: succeeds ? ready : incompatible }));
    let completed!: () => void;
    const done = new Promise<void>(resolve => { completed = resolve; });
    let platformStarted = false, releasePlatform!: () => void;
    const platformGate = new Promise<void>(resolve => { releasePlatform = resolve; });
    const manager = new MachineManagement(platforms, async () => { completed(); }, {
      save: async (...args: Parameters<typeof savePlatform>) => {
        if (mode.startsWith('platform-')) { platformStarted = true; await platformGate; }
        await savePlatform(...args);
      }, forget: forgetPlatform,
    });
    await manager.start();
    let started = false;
    try {
      const job = await manager.begin('owner', repairing ? { id: original.id } : { target: 'onboarding.invalid', label: 'New host', session: 'disposable', platform: posix ? 'posix' : 'windows' });
      started = true;
      assert.throws(() => manager.get('other-owner', job.id), /not found/);
      assert.throws(() => manager.input('other-owner', job.id, 'yes'), /not found/);
      assert.throws(() => manager.cancel('other-owner', job.id), /not found/);
      const cancelledRepair = mode.endsWith('-saved') && !mode.endsWith('failed-saved');
      if (mode.startsWith('platform-')) {
        await wait(() => platformStarted);
        let drained = false;
        if (mode === 'platform-cancel') manager.cancel('owner', job.id);
        else void manager.stop().then(() => { drained = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false);
        assert.equal(manager.get('owner', job.id).cancellable, false);
        releasePlatform();
      } else if (['rename-cancel', 'rename-revoke', 'rename-stop'].includes(mode)) {
        await wait(async () => { try { await access(join(root, 'rename-started')); return true; } catch { return false; } });
        let stopped = false;
        if (mode === 'rename-cancel') manager.cancel('owner', job.id);
        else if (mode === 'rename-revoke') manager.revoke(['owner']);
        else void manager.stop().then(() => { stopped = true; });
        assert.equal(manager.get('owner', job.id).state, 'running');
        assert.equal(manager.get('owner', job.id).cancellable, false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false, 'Shutdown must wait for final publication');
        await writeFile(join(root, 'rename-release'), 'continue');
      } else if (cancelledRepair) {
        await wait(async () => { try { await access(join(root, 'native-saved')); return true; } catch { return false; } });
        assert.equal(JSON.parse(await readFile(catalog, 'utf8')).ssh.length, 2, 'Cancellation must happen after native registration');
        if (mode === 'cancel-saved') {
          const unrelated = { id: '33333333333333333333333333333333', target: 'onboarding.invalid', session: 'disposable', label: 'New host', enabled: true };
          const concurrent = JSON.parse(await readFile(catalog, 'utf8')); concurrent.ssh.push(unrelated);
          await writeFile(catalog, JSON.stringify(concurrent));
          savedCase = JSON.stringify({ version: 1, ssh: [record, unrelated] });
        }
        if (mode.endsWith('cancel-saved')) manager.cancel('owner', job.id);
        else if (mode.endsWith('revoke-saved')) manager.revoke(['owner']);
        else manager.stop();
      } else if (mode === 'decline' || installing) {
        await wait(() => manager.get('owner', job.id).output.includes('[y/N]'));
        manager.input('owner', job.id, installing ? 'yes' : 'no');
      } else if (mode.endsWith('probe')) {
        await wait(async () => { try { await access(join(root, 'status-started')); return true; } catch { return false; } });
        if (mode.startsWith('cancel-')) manager.cancel('owner', job.id);
        else if (mode === 'revoke-probe') manager.revoke(['owner']);
        else manager.stop();
        await writeFile(join(root, 'status-release'), 'continue');
      }
      await wait(() => manager.get('owner', job.id).state !== 'running');
      await done;
      const result = manager.get('owner', job.id);
      assert.equal(result.state, succeeds ? 'complete' : cancelledRepair ? 'cancelled' : installing || posix ? 'failed' : 'cancelled');
      const current = JSON.parse(await readFile(catalog, 'utf8'));
      assert.deepEqual(current.ssh[0], record);
      if (succeeds && repairing) {
        assert.equal(await readFile(catalog, 'utf8'), savedCase, 'Repair preserves the disabled original entry and identity');
        assert.equal(result.machineId, original.id);
        if (posix) await assert.rejects(access(platforms), { code: 'ENOENT' });
        else assert.equal(JSON.parse(await readFile(platforms, 'utf8')).machines[0].id, original.id);
      } else if (succeeds) {
        assert.equal(current.ssh.length, 2);
        assert.equal(current.ssh[1].id, result.machineId);
        assert.match(current.ssh[1].id, /^[a-f0-9]{32}$/);
        assert.equal(current.ssh[1].session, 'disposable');
        assert.equal(JSON.parse(await readFile(platforms, 'utf8')).machines[0].id, result.machineId);
      } else if (mode === 'rename-external') {
        assert.equal(current.ssh.length, 2);
        assert.equal(current.ssh[1].label, 'Externally adopted');
        assert.equal(current.ssh[1].enabled, false);
        assert.equal(result.machineId, undefined);
        assert.doesNotMatch(result.output, /Host registered and ready/);
      } else {
        assert.equal(await readFile(catalog, 'utf8'), savedCase, 'Unsuccessful setup must not register or alter a host');
        if (mode === 'rename-failed') assert.deepEqual(JSON.parse(await readFile(platforms, 'utf8')).machines, []);
        else await assert.rejects(access(platforms), { code: 'ENOENT' });
      }
      const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.filter(call => call.kind === 'ssh').length, posix ? 2 : installing ? mode === 'install-failed' ? 5 : 6 : 3, 'Only explicitly authorized installation may stage or run an installer');
      if (posix) {
        const mutations = calls.filter(call => call.kind === 'herdr' && call.args[1] !== 'list');
        assert.equal(mutations.filter(call => call.args[1] === 'add').length, 1);
        assert.equal(mutations.filter(call => call.args[1] === 'remove').length, (repairing && succeeds) || mode.endsWith('-saved') || mode === 'rename-failed' ? 1 : 0);
        if (!succeeds) assert.match(result.output, cancelledRepair ? /CANCELLED/ : /Native installation declined|NATIVE_SETUP_FAILED|Host publication failed/);
      } else assert.ok(calls.filter(call => call.kind === 'herdr').every(call => call.args.join(' ') === 'machine list --json'));
      if (mode.endsWith('probe')) assert.doesNotMatch(result.output, /\[y\/N\]/, 'Cancelled probes must not create an installation prompt');
      if (!installing || mode === 'install-failed') assert.doesNotMatch(result.output, /HERDR_INSTALL_OK/);
      if (mode.endsWith('install-unready')) assert.match(result.output, /not compatible or ready/);
      if (mode === 'install-failed') assert.match(result.output, /FIXTURE_INSTALL_FAILED/);
    } finally {
      const stopped = manager.stop(); releasePlatform(); await writeFile(join(root, 'status-release'), 'continue'); await writeFile(join(root, 'rename-release'), 'continue');
      if (started) await done;
      await stopped;
    }
  });
});
