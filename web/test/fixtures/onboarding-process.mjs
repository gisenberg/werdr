#!/usr/bin/env node
import { appendFile, readFile, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = process.env.WERDR_ONBOARDING_TEST_ROOT;
if (!root || !basename(root).startsWith('werdr-onboarding-test-')) throw new Error('Missing isolated onboarding fixture');
const args = process.argv.slice(2), kind = basename(process.argv[1]);
await appendFile(join(root, 'calls.jsonl'), JSON.stringify({ kind, args }) + '\n');
if (kind === 'herdr' && args[0] === 'machine' && ['add', 'remove', 'rename'].includes(args[1])) {
  const scenario = JSON.parse(await readFile(join(root, 'scenario.json'), 'utf8'));
  if (!scenario.posix) throw new Error('Unexpected native catalog mutation');
  const path = join(root, 'state/herdr/client/endpoints.json');
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  if (args[1] === 'remove') {
    if (args[2] !== '22222222222222222222222222222222') throw new Error('Refusing to remove unrelated host');
    catalog.ssh = catalog.ssh.filter(machine => machine.id !== args[2]);
  } else if (args[1] === 'rename') {
    if (args[2] !== '22222222222222222222222222222222') throw new Error('Refusing to rename unrelated host');
    const record = catalog.ssh.find(machine => machine.id === args[2]);
    if (!record) throw new Error('Missing staged host');
    if (['rename-cancel', 'rename-revoke', 'rename-stop'].includes(scenario.posix)) {
      await writeFile(join(root, 'rename-started'), 'ready');
      const deadline = Date.now() + 10000;
      while (true) {
        try { await access(join(root, 'rename-release')); break; } catch {}
        if (Date.now() > deadline) throw new Error('Rename gate timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (scenario.posix === 'rename-failed') { console.error('RENAME_FAILED'); process.exit(1); }
    record.label = args[args.indexOf('--label') + 1];
    if (scenario.posix === 'rename-external') { record.label = 'Externally adopted'; record.enabled = false; }
  } else {
    if (args[2] !== 'onboarding.invalid') throw new Error('Unexpected native setup target');
    if (scenario.posix === 'decline') {
      console.log('Install compatible runtime? [y/N]');
      for await (const chunk of process.stdin) { if (chunk.toString().trim()) break; }
      console.error('Native installation declined'); process.exit(1);
    }
    if (scenario.posix === 'failed') { console.error('NATIVE_SETUP_FAILED'); process.exit(1); }
    catalog.ssh.push({ id: '22222222222222222222222222222222', target: args[2], label: args[args.indexOf('--label') + 1], session: args[args.indexOf('--remote-session') + 1], enabled: true });
  }
  await writeFile(path, JSON.stringify(catalog), { mode: 0o600 });
  if (args[1] === 'rename' && scenario.posix === 'rename-error') { console.error('RENAME_ACK_FAILED'); process.exit(1); }
  if (args[1] === 'add' && scenario.posix.endsWith('-saved')) {
    await writeFile(join(root, 'native-saved'), 'ready');
    if (scenario.posix === 'failed-saved') { console.error('NATIVE_SETUP_FAILED'); process.exit(1); }
    // Stay alive after the catalog write so cancellation cannot race the fixture exit.
    await new Promise(resolve => setTimeout(resolve, 10000));
    throw new Error('Saved native repair was not cancelled');
  }
} else if (kind === 'herdr' && args.join(' ') === 'machine list --json') {
  console.log(JSON.stringify(JSON.parse(await readFile(join(root, 'state/herdr/client/endpoints.json'), 'utf8')).ssh));
} else if (kind === 'ssh') {
  if (!args.includes('onboarding.invalid')) throw new Error('Unexpected SSH target');
  if (args.includes('-G')) console.log('hostname 127.0.0.1');
  else if (args.at(-1) === 'exit 0') process.exit(0);
  else {
    const remote = args.at(-1);
    if (!remote.startsWith('pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ')) throw new Error('Unexpected remote command');
    const decoded = Buffer.from(remote.split(' ').at(-1), 'base64').toString('utf16le');
    const scenario = JSON.parse(await readFile(join(root, 'scenario.json'), 'utf8'));
    if (!decoded.includes("'status' '--json'")) {
      if (!scenario.install) throw new Error('Fixture refuses remote installation');
      if (decoded.includes('[IO.FileMode]::CreateNew')) {
        let source = '';
        for await (const chunk of process.stdin) source += chunk;
        if (!source.includes('HERDR_INSTALL_OK')) throw new Error('Expected the managed installer');
        await writeFile(join(root, 'installer-staged'), 'fixture-only');
      } else if (decoded.includes('& $path -Session')) {
        await access(join(root, 'installer-staged'));
        if (scenario.install === 'failed') { console.error('FIXTURE_INSTALL_FAILED'); process.exit(1); }
        await writeFile(join(root, 'installer-finished'), 'fixture-only');
        console.log('HERDR_INSTALL_OK');
      } else throw new Error('Unexpected installation command');
      process.exit(0);
    }
    await writeFile(join(root, 'status-started'), 'ready');
    if (scenario.hold) {
      const deadline = Date.now() + 10000;
      while (true) {
        try { await access(join(root, 'status-release')); break; } catch {}
        if (Date.now() > deadline) throw new Error('Status gate timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    let installed = false;
    try { await access(join(root, 'installer-finished')); installed = true; } catch {}
    console.log(JSON.stringify({ server: installed ? scenario.afterInstall : scenario.server }));
  }
} else throw new Error('Unexpected onboarding fixture invocation');
