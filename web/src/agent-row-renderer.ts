import { canonicalAgents, tokenStyle, type AgentRows } from '../shared/agent-rows';
import type { Agent } from '../shared/fleet';

import { rowStatusIcon, type RowToken } from './sidebar-row-renderer';

interface Context { agent: Agent; machine: string; workspace: string; tab?: string; pane?: string }
const aliases: Record<string, string> = { 'claude-code': 'claude', 'cursor-agent': 'cursor', 'devin-cli': 'devin', 'devin cli': 'devin', antigravity: 'agy', 'antigravity-cli': 'agy', 'mastra-code': 'mastracode', 'mastra code': 'mastracode', opencode2: 'opencode', 'open-code': 'opencode', 'github-copilot': 'copilot', ghcs: 'copilot', 'kimi-code': 'kimi', 'kimi code': 'kimi', 'kiro-cli': 'kiro', 'amp-local': 'amp', 'grok-build': 'grok', 'hermes-agent': 'hermes', 'kilo-code': 'kilo', 'kilo code': 'kilo', qoderclicn: 'qodercli', qoder: 'qodercli', qodercn: 'qodercli', 'qwen-code': 'qwen', 'qwen code': 'qwen', 'muse-code': 'muse', 'muse-cli': 'muse' };
function canonical(label = '') {
  const name = label.trim().toLowerCase().split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|bat)$/i, '');
  return (canonicalAgents as readonly string[]).includes(name) ? name : /^muse-bin-\d/.test(name) ? 'muse' : Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}
export function resolveAgentRows(config: AgentRows, context: Context, indicators: 'text' | 'dots' | 'symbols'): RowToken[][] {
  const { agent } = context;
  const status = agent.agent_status;
  const values: Record<string, string | undefined> = {
    state_icon: rowStatusIcon(status, indicators),
    state_text: agent.state_labels?.[status] ?? (status === 'unknown' ? 'idle' : status),
    machine: context.machine, workspace: context.workspace, tab: context.tab, pane: agent.title ?? context.pane,
    agent: agent.display_agent ?? agent.name ?? agent.agent ?? agent.title,
    terminal_title: agent.terminal_title, terminal_title_stripped: agent.terminal_title_stripped,
  };
  const id = canonical(agent.agent);
  const layout = id && Object.hasOwn(config.rows_by_agent, id) ? config.rows_by_agent[id] : config.rows;
  const rows = layout.map(row => row.flatMap(token => {
    const name = typeof token === 'string' ? token : token.token;
    const value = name.startsWith('$') ? agent.tokens && Object.hasOwn(agent.tokens, name.slice(1)) ? agent.tokens[name.slice(1)] : undefined : values[name];
    if (value === undefined) return [];
    return [{ kind: name.startsWith('$') ? 'custom' : name, text: value, style: tokenStyle(token, value) }];
  })).filter(row => row.length);
  return rows.length ? rows : [[{ kind: 'state_icon', text: values.state_icon!, style: {} }]];
}
