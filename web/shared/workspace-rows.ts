import { fail, record, validateSidebarRows, type SidebarRowToken } from './sidebar-tokens';

export const workspaceRowTokens = ['state_icon', 'state_text', 'workspace', 'branch', 'git_status'] as const;
export interface WorkspaceRows { rows: SidebarRowToken[][]; row_gap: number }
export const defaultWorkspaceRows: WorkspaceRows = { rows: [['state_icon', 'workspace'], ['branch', 'git_status']], row_gap: 0 };
export function validateWorkspaceRows(value: unknown): WorkspaceRows {
  const input = record(value, ['rows', 'row_gap']);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) fail('Workspace row configuration exceeds 16 KiB.');
  const row_gap = input.row_gap === undefined ? 0 : input.row_gap;
  if (!Number.isInteger(row_gap) || (row_gap as number) < 0 || (row_gap as number) > 65535) fail('row_gap must be a whole number from 0 to 65535.');
  return { rows: validateSidebarRows(input.rows === undefined ? defaultWorkspaceRows.rows : input.rows, workspaceRowTokens), row_gap: row_gap as number };
}
