import { canonicalAgent, canonicalAgents } from './agents';

export const soundAgents = canonicalAgents.filter(agent => agent !== 'omp' && agent !== 'mastracode');
export type AgentSoundSetting = 'default' | 'on' | 'off';
export type AgentSounds = Record<string, AgentSoundSetting>;
export const defaultAgentSounds: AgentSounds = Object.fromEntries(soundAgents.map(agent => [agent, agent === 'droid' ? 'off' : 'default']));

export function validateAgentSounds(value: unknown): AgentSounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected per-agent sound settings.');
  const result = { ...defaultAgentSounds };
  for (const [agent, setting] of Object.entries(value)) {
    if (!(soundAgents as readonly string[]).includes(agent) || !['default', 'on', 'off'].includes(setting as string)) throw new Error(`Invalid sound setting for agent: ${agent}.`);
    result[agent] = setting as AgentSoundSetting;
  }
  return result;
}

export function allowsAgentSound(enabled: boolean, settings: AgentSounds, label?: string) {
  if (!enabled) return false;
  const agent = canonicalAgent(label);
  return !agent || settings[agent] !== 'off';
}
