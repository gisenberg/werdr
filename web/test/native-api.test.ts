import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);

test('Windows metadata uses a bounded launch command and preserves concurrent RPC after the stdin source prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-ssh-test-'));
  try {
    // Model the Windows cmd.exe limit and its stdin transport, without requiring
    // Windows or opening an SSH connection in the portable package suite.
    await writeFile(join(directory, 'ssh'), `#!/usr/bin/env node
const command = process.argv.at(-1);
if (command.length > 8191) process.exit(91);
const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
if (script.includes("'status'")) {
 console.log(JSON.stringify({server:{running:true,compatible:true,endpoint_compatible:true,capabilities:{surface_interest:true},socket:'fixture-pipe',version:'fixture'}}));
} else {
 const match=script.match(/byte\\[\\] (\\d+)/); if(!match) process.exit(92);
 let sourceSize=Number(match[1]), pending=Buffer.alloc(0), ready=false;
 process.stdin.on('data', chunk=>{
  pending=Buffer.concat([pending,chunk]);
  if(!ready) {
   if(pending.length<sourceSize) return;
   const source=pending.subarray(0,sourceSize).toString('utf8');
   if(!source.includes('WerdrApiRelay') || source.includes('"method":"session.snapshot"')) process.exit(93);
   pending=pending.subarray(sourceSize); ready=true;
  }
  for(let newline;(newline=pending.indexOf(10))>=0;) {
   const frame=JSON.parse(pending.subarray(0,newline));pending=pending.subarray(newline+1);
   if(frame.cancel) continue;
   const result=frame.request.method==='events.subscribe'?{subscribed:true}:{snapshot:{version:'fixture',request:frame.request.id}};
   process.stdout.write(JSON.stringify({channel:frame.channel,message:{id:frame.request.id,result}})+'\\n');
  }
 });
}
`, { mode: 0o700 });
    const source = `import assert from 'node:assert/strict';
const { nativeEndpoint } = await import('./server/native-api.ts');
const api=await nativeEndpoint({id:'fixture',label:'Fixture',target:'192.168.1.2',session:'fixture',platform:'windows',enabled:true});
try {
 const stop=await api.subscribe([{type:'workspace.created'}],()=>{},()=>{});
 const results=await Promise.all(Array.from({length:8},()=>api.request('session.snapshot')));
 assert.equal(new Set(results.map(result=>result.snapshot.request)).size,8);
 assert.ok(results.every(result=>result.snapshot.version==='fixture')); stop();
} finally { api.close(); }
console.log('WINDOWS_STDIN_TRANSPORT_OK');`;
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: resolve('.'), env: { ...process.env, PATH: directory + ':' + process.env.PATH }, timeout: 15000 });
    assert.match(stdout, /WINDOWS_STDIN_TRANSPORT_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
