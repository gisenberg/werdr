import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowsAgentSound, defaultAgentSounds, soundAgents, validateAgentSounds } from '../shared/agent-sounds.ts';

test('per-agent sound keys and defaults match the native SoundConfig, including Droid off', async () => {
  const native = await readFile(new URL('../../src/config/sound.rs', import.meta.url), 'utf8');
  const canonical = (key: string) => key === 'open_code' ? 'opencode' : key === 'github_copilot' ? 'copilot' : key;
  const fields = native.slice(native.indexOf('pub struct AgentSoundOverrides'), native.indexOf('pub enum AgentSoundSetting'));
  assert.deepEqual([...fields.matchAll(/pub (\w+): AgentSoundSetting/g)].map(match => canonical(match[1])), soundAgents);
  const defaults = native.slice(native.indexOf('impl Default for AgentSoundOverrides'));
  assert.deepEqual(Object.fromEntries([...defaults.matchAll(/(\w+): AgentSoundSetting::(Default|On|Off),/g)].map(match => [canonical(match[1]), match[2].toLowerCase()])), defaultAgentSounds);
});

test('agent overrides respect the global gate, canonical aliases, and explicit default semantics', () => {
  assert.equal(allowsAgentSound(true, defaultAgentSounds, 'Droid'), false);
  assert.equal(allowsAgentSound(true, validateAgentSounds({ droid: 'default' }), 'droid.exe'), true);
  assert.equal(allowsAgentSound(false, validateAgentSounds({ droid: 'on' }), 'Droid'), false);
  assert.equal(allowsAgentSound(true, validateAgentSounds({ claude: 'off' }), '/usr/bin/claude-code'), false);
  assert.equal(allowsAgentSound(true, validateAgentSounds({ copilot: 'off' }), 'github-copilot'), false);
  assert.equal(allowsAgentSound(true, defaultAgentSounds, 'unknown-agent'), true);
  assert.equal(allowsAgentSound(true, defaultAgentSounds), true);
  assert.equal(allowsAgentSound(true, defaultAgentSounds, 'omp'), true);
  for (const value of [null, [], { droid: true }, { codex: 'always' }, { omp: 'off' }, { nonexistent: 'on' }]) assert.throws(() => validateAgentSounds(value));
  const settings = validateAgentSounds({}); settings.claude = 'off'; assert.equal(defaultAgentSounds.claude, 'default');
});
