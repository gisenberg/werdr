import { popupSession, type PopupSession } from './popups.ts';
export const commandActions = ['shell', 'pane', 'popup', 'plugin_action'] as const;
export interface CommandTarget { workspace_id: string; tab_id: string; pane_id: string; terminal_id: string }
export interface CommandSelection { anchor: { row: number; col: number }; cursor: { row: number; col: number }; content_revision: number }
export type CommandEffect = { type: 'shell_started' } | { type: 'pane_created'; pane: CommandTarget } | { type: 'popup_opened'; popup: PopupSession } | { type: 'plugin_started'; plugin_id: string; log_id: string } | { type: 'unknown' };
export function commandTarget(value: unknown): CommandTarget {
  if (!value || typeof value !== 'object') throw new Error('Invalid command target.');
  const item = value as Record<string, unknown>, result = {} as CommandTarget;
  for (const key of ['workspace_id', 'tab_id', 'pane_id', 'terminal_id'] as const) {
    if (typeof item[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(item[key])) throw new Error('Invalid command target.');
    result[key] = item[key];
  }
  return result;
}
export function commandEffect(value: unknown): CommandEffect {
  if (!value || typeof value !== 'object') throw new Error('Native command outcome is unavailable.');
  const item = value as Record<string, unknown>;
  if (item.type === 'shell_started') return { type: 'shell_started' };
  if (item.type === 'pane_created') return { type: 'pane_created', pane: commandTarget(item.pane) };
  if (item.type === 'popup_opened') { const popup = popupSession(item.popup); if (!popup) throw new Error('Native popup outcome is unavailable.'); return { type: 'popup_opened', popup }; }
  if (item.type === 'plugin_started') {
    if (typeof item.plugin_id !== 'string' || !item.plugin_id || item.plugin_id.length > 256 || typeof item.log_id !== 'string' || !item.log_id || item.log_id.length > 256) throw new Error('Native plugin outcome is unavailable.');
    return { type: 'plugin_started', plugin_id: item.plugin_id, log_id: item.log_id };
  }
  return { type: 'unknown' };
}
export type CommandAction = typeof commandActions[number];
export interface NativeCommand { command_id: string; binding_labels: string[]; action: CommandAction; description?: string }
export type CommandCatalog = { status: 'loading' | 'unavailable'; commands: [] } | { status: 'ready'; commands: NativeCommand[] };

// Unknown future action kinds do not disable the commands this client understands.
// IDs are endpoint-issued capabilities, never executable command text.
export function commandCatalog(value: unknown): NativeCommand[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid native command catalog.');
  const commands: NativeCommand[] = [], ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') throw new Error('Invalid native command entry.');
    if (!(commandActions as readonly string[]).includes(item.action)) continue;
    if (typeof item.command_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(item.command_id) || ids.has(item.command_id)
      || !Array.isArray(item.binding_labels) || item.binding_labels.length > 128 || item.binding_labels.some((label: unknown) => typeof label !== 'string' || !label || label.length > 128)
      || item.description !== undefined && item.description !== null && (typeof item.description !== 'string' || item.description.length > 4096)) throw new Error('Invalid native command entry.');
    ids.add(item.command_id);
    commands.push({ command_id: item.command_id, action: item.action, binding_labels: [...item.binding_labels], ...(typeof item.description === 'string' ? { description: item.description } : {}) });
  }
  return commands;
}
