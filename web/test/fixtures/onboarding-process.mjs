#!/usr/bin/env node
import { appendFile, readFile, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = process.env.WERDR_ONBOARDING_TEST_ROOT;
if (!root || !basename(root).startsWith('werdr-onboarding-test-')) throw new Error('Missing isolated onboarding fixture');
const args = process.argv.slice(2), kind = basename(process.argv[1]);
await appendFile(join(root, 'calls.jsonl'), JSON.stringify({ kind, args }) + '\n');
if (kind === 'herdr' && args.join(' ') === 'machine list --json') {
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
