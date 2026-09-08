import { worktreeAction } from './worktree-actions.ts';
import { copyAction, copyReadActions } from './copy-actions.ts';
import { publicId } from './herdr.ts';
import { ManagementError } from './machine-management.ts';

const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /\0/.test(value)) throw new ManagementError('Invalid action text.');
  return value;
};
export function browserAction(value: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const method = String(value.action);
  if (copyReadActions.has(method) || method === 'pane.scroll') return copyAction(value);
  if (method.startsWith('worktree.')) return worktreeAction(value);
  const id = () => publicId(value.id);
  switch (method) {
    case 'integration.list': return { method, params: {} };
    case 'integration.install':
    case 'integration.uninstall':
      if (typeof value.target !== 'string' || !['pi', 'omp', 'claude', 'codex', 'copilot', 'devin', 'droid', 'kimi', 'opencode', 'kilo', 'hermes', 'qodercli', 'qwen', 'cursor', 'mastracode', 'antigravity_cli', 'grok'].includes(value.target)) throw new ManagementError('Invalid integration target.');
      return { method, params: { target: value.target } };

    case 'workspace.create': return { method, params: { ...(value.label ? { label: text(value.label) } : {}), ...(value.source ? { source_workspace_id: publicId(value.source) } : {}) } };
    case 'workspace.close':
      if (value.close_group !== undefined && typeof value.close_group !== 'boolean') throw new ManagementError('Invalid workspace group closure.');
      return { method, params: { workspace_id: id(), ...(value.close_group === true ? { close_group: true } : {}) } };
    case 'workspace.rename': return { method, params: { workspace_id: id(), label: text(value.label) } };
    case 'tab.create': return { method, params: { workspace_id: id(), ...(value.label ? { label: text(value.label) } : {}) } };
    case 'tab.close': return { method, params: { tab_id: id() } };
    case 'tab.rename': return { method, params: { tab_id: id(), label: text(value.label) } };
    case 'layout.set_split_ratio':
      if (!Array.isArray(value.path) || value.path.length > 64 || value.path.some(item => typeof item !== 'boolean') || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio) || value.ratio < .05 || value.ratio > .95) throw new ManagementError('Invalid split ratio.');
      return { method, params: { tab_id: id(), path: value.path, ratio: value.ratio } };
    case 'pane.zoom':
      if (!['toggle', 'on', 'off'].includes(String(value.mode))) throw new ManagementError('Invalid zoom mode.');
      return { method, params: { pane_id: id(), mode: value.mode } };
    case 'pane.swap':
      if (value.source !== undefined || value.target !== undefined) {
        if (value.direction !== undefined) throw new ManagementError('Choose pane ids or a direction for swapping.');
        const source = publicId(value.source), target = publicId(value.target);
        if (source === target) throw new ManagementError('Choose two different panes.');
        return { method, params: { source_pane_id: source, target_pane_id: target } };
      }
      if (!['left', 'right', 'up', 'down'].includes(String(value.direction))) throw new ManagementError('Invalid pane direction.');
      return { method, params: { pane_id: id(), direction: value.direction } };
    case 'pane.focus_direction':
    case 'pane.resize':
      if (!['left', 'right', 'up', 'down'].includes(String(value.direction))) throw new ManagementError('Invalid pane direction.');
      return { method, params: { pane_id: id(), direction: value.direction, ...(method === 'pane.resize' ? { amount: .05 } : {}) } };
    case 'tab.move':
    case 'workspace.move':
      if (!Number.isSafeInteger(value.index) || Number(value.index) < 0 || Number(value.index) > 10000) throw new ManagementError('Invalid position.');
      return { method, params: { [method === 'tab.move' ? 'tab_id' : 'workspace_id']: id(), insert_index: value.index } };
    case 'pane.move': {
      let destination: object;
      if (value.destination === 'tab') {
        if (!['right', 'down'].includes(String(value.direction))) throw new ManagementError('Invalid split direction.');
        destination = { type: 'tab', tab_id: publicId(value.tab), split: value.direction };
      } else if (value.destination === 'new_tab') destination = { type: 'new_tab' };
      else if (value.destination === 'new_workspace') destination = { type: 'new_workspace' };
      else throw new ManagementError('Invalid pane destination.');
      return { method, params: { pane_id: id(), destination, focus: true } };
    }
    case 'pane.close': return { method, params: { pane_id: id() } };
    case 'pane.rename': return { method, params: { pane_id: id(), label: value.label === null ? null : text(value.label) } };
    case 'pane.split':
      if (!['right', 'down'].includes(String(value.direction))) throw new ManagementError('Invalid split direction.');
      return { method, params: { target_pane_id: id(), direction: value.direction } };
    case 'agent.rename': return { method, params: { target: id(), name: text(value.name) } };
    case 'agent.prompt': return { method, params: { target: id(), text: text(value.text, 32768) } };
    case 'agent.start': {
      if (typeof value.kind !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.kind)) throw new ManagementError('Invalid agent kind.');
      const args = value.args ?? [];
      if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 || arg.includes('\0'))) throw new ManagementError('Invalid agent arguments.');
      return { method, params: { pane_id: id(), kind: value.kind, name: text(value.name), args, timeout_ms: 60_000 } };
    }
    default: throw new ManagementError('Unsupported browser action.');
  }
}
