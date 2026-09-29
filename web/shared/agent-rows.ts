import { canonicalAgents } from './agents';
import { fail, record, validateSidebarRows, type SidebarRowToken } from './sidebar-tokens';
export { tokenStyle, type TokenStyle, type TokenRule } from './sidebar-tokens';
export type AgentRowToken = SidebarRowToken;
// Mirrors the native sidebar.agents format in src/config/sidebar.rs and rules.rs.
export const agentRowTokens = ['state_icon', 'state_text', 'machine', 'workspace', 'tab', 'pane', 'agent', 'terminal_title', 'terminal_title_stripped'] as const;
export { canonicalAgents } from './agents';
export interface AgentRows { rows: AgentRowToken[][]; rows_by_agent: Record<string, AgentRowToken[][]>; row_gap: number }
export const defaultAgentRows: AgentRows = { rows: [['state_icon', 'machine', 'workspace', 'tab'], ['agent']], rows_by_agent: {}, row_gap: 0 };
export const detailedAgentRows: AgentRows = { rows: [['state_icon', 'machine', 'workspace'], ['agent', 'state_text'], ['pane', 'terminal_title_stripped']], rows_by_agent: {}, row_gap: 1 };
export function validateAgentRows(value: unknown): AgentRows {
  const input = record(value, ['rows', 'rows_by_agent', 'row_gap']);
  // Keep the whole preferences request within its existing bounded endpoint.
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) fail('Agent row configuration exceeds 16 KiB.');
  const overrides = record(input.rows_by_agent === undefined ? {} : input.rows_by_agent);
  const rows_by_agent: AgentRows['rows_by_agent'] = {};
  for (const [agent, layout] of Object.entries(overrides)) {
    if (!(canonicalAgents as readonly string[]).includes(agent)) fail(`Unknown canonical agent: ${agent}.`);
    rows_by_agent[agent] = validateSidebarRows(layout, agentRowTokens);
  }
  const row_gap = input.row_gap === undefined ? 0 : input.row_gap;
  if (!Number.isInteger(row_gap) || (row_gap as number) < 0 || (row_gap as number) > 65535) fail('row_gap must be a whole number from 0 to 65535.');
  return { rows: validateSidebarRows(input.rows === undefined ? defaultAgentRows.rows : input.rows, agentRowTokens), rows_by_agent, row_gap: row_gap as number };
}
