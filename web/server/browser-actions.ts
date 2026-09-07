import { publicId } from './herdr.ts';
import { ManagementError } from './machine-management.ts';

const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /\0/.test(value)) throw new ManagementError('Invalid action text.');
  return value;
};
export function browserAction(value: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const method = String(value.action);
  const id = () => publicId(value.id);
  switch (method) {
    case 'workspace.create': return { method, params: { ...(value.label ? { label: text(value.label) } : {}), ...(value.source ? { source_workspace_id: publicId(value.source) } : {}) } };
    case 'workspace.close': return { method, params: { workspace_id: id() } };
    case 'workspace.rename': return { method, params: { workspace_id: id(), label: text(value.label) } };
    case 'tab.create': return { method, params: { workspace_id: id(), ...(value.label ? { label: text(value.label) } : {}) } };
    case 'tab.close': return { method, params: { tab_id: id() } };
    case 'tab.rename': return { method, params: { tab_id: id(), label: text(value.label) } };
    case 'pane.close': return { method, params: { pane_id: id() } };
    case 'pane.rename': return { method, params: { pane_id: id(), label: text(value.label) } };
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
