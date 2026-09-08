import type { AgentStatus, Workspace } from '../shared/fleet';
import { tokenStyle } from '../shared/sidebar-tokens';
import type { WorkspaceRows } from '../shared/workspace-rows';
import { rowStatusIcon, type RowToken } from './sidebar-row-renderer';

interface Context { workspace: Workspace; status: AgentStatus; indented: boolean }

// Resolve the same cached facts as native space_rows. No terminal or Git queries.
export function resolveWorkspaceRows(config: WorkspaceRows, context: Context, indicators: 'text' | 'dots' | 'symbols'): RowToken[][] {
  const { workspace, status, indented } = context;
  const label = indented && workspace.custom_label === false && workspace.branch !== undefined
    ? workspace.branch.replace(/^worktree\//, '') : workspace.label;
  const runs: NonNullable<RowToken['runs']> = [];
  if (!indented && workspace.git_ahead_behind) {
    const [ahead, behind] = workspace.git_ahead_behind;
    if (ahead > 0) runs.push({ text: `↑${ahead}`, tone: 'green' });
    if (ahead > 0 && behind > 0) runs.push({ text: ' ' });
    if (behind > 0) runs.push({ text: `↓${behind}`, tone: 'red' });
  }
  const values: Record<string, string | undefined> = {
    state_icon: rowStatusIcon(status, indicators), state_text: status === 'unknown' ? 'idle' : status,
    workspace: label, branch: indented ? undefined : workspace.branch,
    git_status: runs.length ? runs.map(run => run.text).join('') : undefined,
  };
  return config.rows.map(row => row.flatMap(token => {
    const name = typeof token === 'string' ? token : token.token;
    const value = name.startsWith('$') ? workspace.tokens && Object.hasOwn(workspace.tokens, name.slice(1)) ? workspace.tokens[name.slice(1)] : undefined : values[name];
    if (value === undefined) return [];
    const result: RowToken = { kind: name.startsWith('$') ? 'custom' : name, text: value, style: tokenStyle(token, value) };
    if (name === 'git_status') result.runs = runs;
    return [result];
  })).filter(row => row.length);
}
