import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginInstallArgs, pluginInstallInvocation } from '../server/plugin-install.ts';

test('GitHub installation accepts native source paths and refs without arbitrary CLI switches', () => {
  assert.deepEqual(pluginInstallArgs({ operation: 'install', source: 'owner/repo/path with spaces', ref: 'feature/install', yes: true, command: 'bad' }), ['plugin', 'install', 'owner/repo/path with spaces', '--ref', 'feature/install']);
  for (const source of ['https://github.com/a/b', 'a/b/../c', 'a/b//c', 'a/b\\c', 'a/b\nc', 'a', 'a/..']) assert.throws(() => pluginInstallArgs({ operation: 'install', source }));
  for (const ref of ['--upload-pack=bad', 'a:b', 'foo..bar', 'foo\nbar', 'foo*', 'foo@{1}']) assert.throws(() => pluginInstallArgs({ operation: 'install', source: 'a/b', ref }));
  assert.deepEqual(pluginInstallArgs({ operation: 'uninstall', plugin: 'example.tool' }), ['plugin', 'uninstall', 'example.tool']);
  assert.throws(() => pluginInstallArgs({ operation: 'uninstall', plugin: '../tool' }));
});

test('interactive installers preserve the saved session and use a trusted SSH PTY with shell-quoted arguments', () => {
  const args = pluginInstallArgs({ operation: 'install', source: "owner/repo/it's a dir", ref: 'v1' });
  const [, local] = pluginInstallInvocation({ id: 'local', label: 'host', enabled: true, session: 'isolated' }, args);
  assert.deepEqual(local.slice(2), ['--session', 'isolated', ...args]);
  const [, posix] = pluginInstallInvocation({ id: 'remote', label: 'host', enabled: true, target: 'user@private', session: 'isolated' }, args);
  assert.equal(posix[1], 'ssh'); assert.equal(posix[2], '-tt'); assert.ok(posix.includes('StrictHostKeyChecking=yes'));
  assert.ok(posix.at(-1)!.includes("'owner/repo/it'\\''s a dir'")); assert.ok(!posix.includes('--yes'));
  const [, windows] = pluginInstallInvocation({ id: 'win', label: 'host', enabled: true, target: 'user@private', session: 'isolated', platform: 'windows' }, args);
  const script = Buffer.from(windows.at(-1)!.split(' ').at(-1)!, 'base64').toString('utf16le');
  assert.ok(script.includes("'owner/repo/it''s a dir'")); assert.ok(script.includes("'--session' 'isolated'")); assert.ok(!script.includes('--yes'));
});
