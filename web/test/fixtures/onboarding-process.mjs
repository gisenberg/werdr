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
    if (!decoded.includes("'status' '--json'")) throw new Error('Fixture refuses remote installation');
    const scenario = JSON.parse(await readFile(join(root, 'scenario.json'), 'utf8'));
    await writeFile(join(root, 'status-started'), 'ready');
    if (scenario.hold) {
      const deadline = Date.now() + 10000;
      while (true) {
        try { await access(join(root, 'status-release')); break; } catch {}
        if (Date.now() > deadline) throw new Error('Status gate timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    console.log(JSON.stringify({ server: scenario.server }));
  }
} else throw new Error('Unexpected onboarding fixture invocation');
