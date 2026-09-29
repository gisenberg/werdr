import { randomBytes } from 'node:crypto';
import { noticeEndpointKey, type Machine, type Notice, type NoticeKind } from '../shared/fleet.ts';

const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const string = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length <= max;
export function readNotices(stored: unknown): Notice[] {
  if (stored === undefined) return [];
  const value = stored as { version?: unknown; notices?: unknown };
  if (!value || ![1, 2].includes(value.version as number) || !Array.isArray(value.notices) || value.notices.length > 256) throw new Error('Invalid or unsupported fleet notification store');
  const allowed = ['id', 'machineId', 'machineLabel', 'paneId', 'workspaceId', 'tabId', 'title', 'body', 'kind', 'created', 'read', 'endpointKey', 'terminalId', 'sound', 'agent', 'position'];
  const notices: Notice[] = value.notices.map((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !allowed.includes(key)) || !Number.isSafeInteger(item.created) || item.created < 0 || typeof item.read !== 'boolean' || !(value.version === 1 ? ['attention', 'finished'] : ['attention', 'finished', 'update', 'custom']).includes(item.kind) || ['id', 'machineId', 'machineLabel', 'paneId', 'workspaceId', 'tabId', 'title'].some(key => !string(item[key])) || !string(item.body, 8192) || ['endpointKey', 'terminalId', 'agent'].some(key => item[key] !== undefined && !string(item[key], key === 'endpointKey' ? 8192 : 1024)) || item.sound !== undefined && !['done', 'request'].includes(item.sound) || item.position !== undefined && !positions.includes(item.position)) throw new Error('Invalid fleet notification record');
    // Legacy history has no trustworthy terminal or endpoint identity. Keep the
    // row without reconstructing a destination from possibly reused public IDs.
    const result = { ...item };
    if (value.version === 1) { delete result.endpointKey; delete result.terminalId; }
    return result;
  });
  if (new Set(notices.map(notice => notice.id)).size !== notices.length) throw new Error('Duplicate fleet notification identity');
  return notices;
}

export function semanticNotice(data: any, machine: Machine): Notice | undefined {
  if (!data || typeof data !== 'object') return;
  const kinds: Record<string, NoticeKind> = { needs_attention: 'attention', finished: 'finished', update_installed: 'update', custom: 'custom' };
  if (!Object.hasOwn(kinds, data.kind) || !string(data.title) || !data.title || data.body != null && !string(data.body, 8192) || ['pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'agent'].some(key => data[key] != null && !string(data[key])) || data.sound != null && !['done', 'request'].includes(data.sound) || data.position != null && !positions.includes(data.position)) return;
  if (data.pane_id && !data.terminal_id) return;
  return {
    id: randomBytes(16).toString('hex'), machineId: machine.id, machineLabel: machine.label, endpointKey: noticeEndpointKey(machine),
    paneId: data.pane_id ?? '', workspaceId: data.workspace_id ?? '', tabId: data.tab_id ?? '',
    ...(data.terminal_id ? { terminalId: data.terminal_id } : {}), title: data.title, body: data.body ?? '', kind: kinds[data.kind],
    ...(data.sound ? { sound: data.sound } : {}), ...(data.agent ? { agent: data.agent } : {}), ...(data.position ? { position: data.position } : {}),
    created: Date.now(), read: false,
  };
}
