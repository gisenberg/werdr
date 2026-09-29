export type PopupSize = number | `${number}%`;
export interface PopupSession {
  terminal_id: string;
  owner_workspace_id: string;
  owner_tab_id: string;
  width?: PopupSize;
  height?: PopupSize;
}
export type PopupState = { status: 'loading' | 'unavailable' } | { status: 'ready'; popup: PopupSession | null };

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const size = (value: unknown): value is PopupSize => typeof value === 'number' ? Number.isInteger(value) && value >= 0 && value <= 65535 : typeof value === 'string' && /^(?:[1-9]|[1-9][0-9]|100)%$/.test(value);
export function popupSession(value: unknown): PopupSession | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Invalid native popup session.');
  const item = value as Record<string, unknown>;
  if (!identifier(item.terminal_id) || !identifier(item.owner_workspace_id) || !identifier(item.owner_tab_id)
    || item.width != null && !size(item.width) || item.height != null && !size(item.height)) throw new Error('Invalid native popup session.');
  return { terminal_id: item.terminal_id, owner_workspace_id: item.owner_workspace_id, owner_tab_id: item.owner_tab_id,
    ...(size(item.width) ? { width: item.width } : {}), ...(size(item.height) ? { height: item.height } : {}) };
}
