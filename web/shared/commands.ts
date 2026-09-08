export const commandActions = ['shell', 'pane', 'popup', 'plugin_action'] as const;
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
