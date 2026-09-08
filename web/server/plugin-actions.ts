import { publicId } from './herdr.ts';
import { commandTarget } from '../shared/commands.ts';
import { popupSession } from '../shared/popups.ts';
import { ManagementError } from './machine-management.ts';
import type { Plugin, PluginPlacement } from '../shared/plugins.ts';

type Request = (method: string, params?: object, invalidate?: boolean) => Promise<any>;
const pluginId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9.:_-]{1,120}$/.test(value.trim())) throw new ManagementError('Invalid plugin ID.');
  return value.trim();
};
const entrypointId = (value: unknown) => {
  const id = pluginId(value); if (id.includes('.')) throw new ManagementError('Choose an entrypoint within this plugin.'); return id;
};
function text(value: unknown, label: string, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) throw new ManagementError(`Invalid ${label}.`);
  return value;
}

// Use the selected host's native registry and commands. Browser payloads cannot
// substitute argv, environment variables, installation provenance, or context metadata.
export async function pluginAction(value: Record<string, unknown>, request: Request) {
  const method = String(value.action);
  if (method === 'plugin.list' || method === 'plugin.action.list' || method === 'plugin.log.list') {
    const plugin = value.plugin_id === undefined ? {} : { plugin_id: pluginId(value.plugin_id) };
    const limit = value.limit ?? 50;
    if (method === 'plugin.log.list' && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200)) throw new ManagementError('Choose between 1 and 200 command logs.');
    return request(method, { ...plugin, ...(method === 'plugin.log.list' ? { limit } : {}) }, false);
  }
  if (method === 'plugin.link') {
    if (typeof value.enabled !== 'boolean') throw new ManagementError('Choose whether to enable the plugin.');
    return request(method, { path: text(value.path, 'plugin directory'), enabled: value.enabled });
  }
  if (['plugin.unlink', 'plugin.enable', 'plugin.disable'].includes(method)) return request(method, { plugin_id: pluginId(value.plugin_id) });
  if (method === 'plugin.pane.focus' || method === 'plugin.pane.close') return request(method, { pane_id: publicId(value.pane_id) });
  if (method !== 'plugin.action.invoke' && method !== 'plugin.pane.open') throw new ManagementError('Unsupported plugin action.');
  const plugin_id = pluginId(value.plugin_id);
  const pane_id = value.pane_id === undefined ? undefined : publicId(value.pane_id);
  if (method === 'plugin.action.invoke') {
    const action_id = entrypointId(value.action_id);
    const selection = value.selected_text === undefined || value.selected_text === '' ? {} : { selected_text: text(value.selected_text, 'selected text', 32768) };
    // Native context includes cwd, worktree, agent and labels, including absent
    // fields. Let it derive these together after applying the explicit pane focus.
    if (pane_id) await request('pane.focus', { pane_id });
    return request(method, { plugin_id, action_id, context: { invocation_source: 'browser', ...selection } });
  }
  const entrypoint = entrypointId(value.entrypoint);
  const { plugins }: { plugins: Plugin[] } = await request('plugin.list', { plugin_id }, false);
  const plugin = plugins.find(plugin => plugin.plugin_id === plugin_id);
  const entry = plugin?.panes?.find(pane => pane.id === entrypoint);
  if (!entry) throw new ManagementError('The plugin pane entrypoint is no longer available. Refresh the plugin list.');
  const placement = (value.placement ?? entry.placement) as PluginPlacement;
  if (!['overlay', 'popup', 'split', 'tab', 'zoomed'].includes(placement)) throw new ManagementError('Invalid plugin pane placement.');
  const cwd = value.cwd === undefined || value.cwd === '' ? {} : { cwd: text(value.cwd, 'pane working directory') };
  if (placement === 'popup') {
    let target;
    try { target = commandTarget(value.target); } catch { throw new ManagementError('Choose an exact source pane for the popup.'); }
    if (pane_id !== undefined && pane_id !== target.pane_id || value.workspace_id !== undefined && publicId(value.workspace_id) !== target.workspace_id) throw new ManagementError('Popup source identity does not match the selected pane.');
    const result = await request('plugin.popup.open', { plugin_id, entrypoint, target, ...cwd });
    const popup = popupSession(result?.popup);
    if (!popup) throw new ManagementError('The native popup outcome is unavailable. Check the host before opening another popup.');
    return { type: 'popup_opened', popup };
  }
  const params: Record<string, unknown> = { plugin_id, entrypoint, placement, focus: true, ...cwd };
  if (placement === 'tab') params.workspace_id = publicId(value.workspace_id);
  else {
    if (!pane_id) throw new ManagementError('Choose a pane for the plugin.');
    if (placement === 'overlay') await request('pane.focus', { pane_id });
    else {
      params.target_pane_id = pane_id;
      const direction = value.direction ?? 'right';
      if (direction !== 'right' && direction !== 'down') throw new ManagementError('Invalid split direction.');
      params.direction = direction;
    }
  }
  return request(method, params);
}
