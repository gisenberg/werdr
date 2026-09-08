import { SidebarSplit } from './sidebar-split';
import { workspaceEntries, workspaceGroup, workspaceGroupKey } from './workspace-groups';
import { ContextMenu, type ContextAction } from './context-menu';
import { attentionTarget, navigationTargets, resolveNavigationTarget } from './navigation-targets';
import { BootConsole } from './boot';
import { RuntimeSettings, runtimeSettingsMarkup } from './runtime-settings';
import { Integrations, integrationsMarkup } from './integrations';
import { Plugins, pluginsMarkup } from './plugins';
import { Worktrees, worktreesMarkup } from './worktrees';
import { DesktopSurface } from './desktop-surface';
import './style.css';

import type { Agent, FleetState, HostView, Notice, Snapshot, Workspace } from '../shared/fleet';
import { emptySnapshot } from '../shared/fleet';
import { FleetClient } from './fleet-client';
import { HostManager, hostManagerMarkup } from './host-manager';
import { Activity, activityMarkup } from './activity';
import { initializeAccount } from './account';
import { Settings, settingsMarkup } from './settings';
import { defaults, palette, type Preferences } from '../shared/settings';
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header><button id="host-toggle" aria-expanded="false" aria-controls="rail">[H] HOSTS</button><strong>werdr<span> / WEB TERMINAL</span></strong><div class="account-actions"><button id="settings" hidden>SETTINGS</button><button id="sessions" hidden>SESSIONS</button><button id="access-token" hidden>ACCESS TOKEN</button><button id="logout">[X] SIGN OUT</button></div></header>
<main><aside id="rail"><div class="rail-catalog"><div class="rail-tools"><button id="manage-hosts">MANAGE HOSTS</button><button id="activity">ACTIVITY</button><button id="commands" aria-label="Command palette" title="Command palette (Ctrl/Cmd+K)">[K]</button></div><label class="rail-search">FIND<input id="fleet-search" type="search" placeholder="Hosts, workspaces, agents" autocomplete="off"></label><div class="section">HOSTS <button id="refresh" aria-label="Refresh hosts">[R]</button></div><nav id="hosts" aria-label="Hosts"></nav></div><div id="rail-sections"><div class="rail-panel"><div class="section">WORKSPACES <button id="create" aria-label="Create workspace">[+]</button></div><nav id="workspaces" aria-label="Workspaces"></nav></div><div id="rail-divider" role="separator" tabindex="0" aria-label="Workspace and agent section sizes" aria-orientation="horizontal" aria-controls="workspaces agents" aria-valuemin="10" aria-valuemax="90" aria-valuenow="50" title="Drag to resize workspaces and agents. Arrow keys adjust; Home/End set limits."></div><div class="rail-panel"><div class="section">AGENTS<select id="agent-filter" aria-label="Filter agents"><option value="all">ALL</option><option value="blocked">ATTENTION</option><option value="working">WORKING</option><option value="done">DONE / IDLE</option></select></div><nav id="agents" aria-label="Agents"></nav></div></div></aside>
<section id="surface"><nav id="tabs" aria-label="Tabs"></nav><nav id="panes" aria-label="Panes"></nav><div id="terminal"></div><div id="shield" role="status">Select a workspace to attach.</div></section></main>
<footer><span id="status" role="status">[WAIT] CONNECTING</span><div><button id="new-tab">[+] TAB</button><button id="split">[|] SPLIT</button><button id="pane-actions">ACTIONS</button><button id="takeover">TAKE CONTROL</button><button id="close">CLOSE PANE</button></div></footer>
<dialog id="token-dialog"><h1>Access token</h1><p>Generate a new token to sign in on another browser. This replaces the previous token and signs out browsers using it.</p><button id="generate-token">GENERATE TOKEN</button><button id="revoke-token">REVOKE ACCESS TOKEN</button><label id="generated-token-field" hidden>NEW ACCESS TOKEN<input id="generated-token" readonly autocomplete="off" spellcheck="false"></label><p id="token-error" role="alert"></p><button id="token-done">DONE</button></dialog>
<dialog id="sessions-dialog"><h1>Signed-in browsers</h1><p>Browser tokens stay valid for 90 days, including across restarts. Revoking a browser disconnects it immediately.</p><div id="session-list"></div><p id="session-error" role="alert"></p><button id="revoke-others">REVOKE OTHER BROWSERS</button><button id="sessions-done">DONE</button></dialog>
${hostManagerMarkup}${activityMarkup}${settingsMarkup}${worktreesMarkup}${integrationsMarkup}${runtimeSettingsMarkup}${pluginsMarkup}
<dialog id="command-dialog"><h1>COMMANDS</h1><label>FIND ACTION<input id="command-search" type="search" autocomplete="off" placeholder="Search actions, hosts, workspaces, agents"></label><div id="command-list"></div><button id="command-done">DONE</button></dialog>
<dialog id="rename-dialog"><form id="rename-form"><h1 id="rename-title">RENAME</h1><label>LABEL<input id="rename-value" required maxlength="256"></label><button type="submit">SAVE</button><button id="rename-cancel" type="button">CANCEL</button><p id="rename-error" role="alert"></p></form></dialog>
<dialog id="agent-dialog"><h1>AGENT</h1><p id="agent-context"></p><form id="agent-start-form"><label>AGENT KIND<input id="agent-kind" value="claude" list="agent-kinds" required maxlength="80" autocomplete="off"><datalist id="agent-kinds"><option value="claude"><option value="codex"><option value="opencode"><option value="aider"><option value="gemini"></datalist></label><label>NAME<input id="agent-name" required maxlength="256" autocomplete="off"></label><button type="submit">START AGENT IN THIS PANE</button></form><form id="agent-prompt-form"><label>PROMPT<textarea id="agent-prompt" required maxlength="32768" rows="5"></textarea></label><button type="submit">SEND PROMPT</button></form><p id="agent-error" role="alert"></p><button id="agent-done">DONE</button></dialog>`;
const contextMenu = new ContextMenu();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const boot = new BootConsole(value => api('/api/login', value), refresh);
const status = (text: string) => { element('status').textContent = text; };
let machineId = 'local', workspaceId = '', tabId = '', paneId = '';
let snapshot: Snapshot = emptySnapshot();
let fleetState: FleetState = { revision: 0, hosts: [], notices: [] };
let pendingHost: string | undefined;
let pendingPane: { machine: string; pane: string; tab: string } | undefined;
const selections = new Map<string, { workspace: string; tab: string; pane: string }>();
try {
  const saved = JSON.parse(localStorage.getItem('werdr-selection') || '{}');
  const query = new URLSearchParams(location.search);
  machineId = query.get('machine') || saved.machine || 'local'; workspaceId = query.get('workspace') || saved.workspace || ''; tabId = query.get('tab') || saved.tab || ''; paneId = query.get('pane') || saved.pane || '';
} catch {}
let remembered = '';
function rememberSelection() {
  const value = { machine: machineId, workspace: workspaceId, tab: tabId, pane: paneId }; const encoded = JSON.stringify(value);
  if (remembered === encoded) return; remembered = encoded; selections.set(machineId, value);
  try { localStorage.setItem('werdr-selection', encoded); } catch {}
  const url = new URL(location.href); for (const [key, item] of Object.entries(value)) { if (item) url.searchParams.set(key, item); else url.searchParams.delete(key); }
  history.replaceState(null, '', url);
}
let authenticated = false, refreshing = false, refreshAgain = false;
let interactionRevision = 0;
const pendingGroups = new Set<string>();
let closingFocus: { machine: string; workspace: string; tab: string } | undefined;
for (const type of ['pointerdown', 'keydown', 'paste', 'focusin']) document.addEventListener(type, () => { ++interactionRevision; closingFocus = undefined; }, true);
let gatewayOnline = false;
const fleet = new FleetClient(applyFleet, online => {
  const recovered = online && !gatewayOnline; gatewayOnline = online;
  if (!authenticated) return;
  if (!online) { status('[RECONNECTING] GATEWAY'); void refresh(); }
  else if (recovered) surface.recover();
});
const hostManager = new HostManager(api, id => selectHost(id));
let preferences: Preferences = structuredClone(defaults), colors = palette(defaults, false);
const surface = new DesktopSurface(element('terminal'), element('shield'), element('panes'), api, preferences, colors, selectPane, message => status(`[ERROR] ${message}`), message => status(`[OK] ${message}`));
function selectPane(id: string) { if (paneId === id && !pendingPane) return; pendingPane = undefined; paneId = id; choose(); renderFleetNavigation(); }
const activity = new Activity(api, selectTarget, () => ({ machine: machineId, pane: paneId }), () => preferences);
const integrations = new Integrations(api, () => { const host = selectedHost(); return host?.connection === 'online' ? { machine: machineId, label: host.machine.label } : undefined; });
const runtimeSettings = new RuntimeSettings(api, () => { const host = selectedHost(); return host?.connection === 'online' ? { machine: machineId, label: host.machine.label } : undefined; });
const plugins = new Plugins(api, () => { const host = selectedHost(); return host?.connection === 'online' ? { machine: machineId, label: host.machine.label, workspace: workspaceId || undefined, pane: paneId || undefined, selectedText: surface.active?.readSelection() } : undefined; }, (machine, pane) => selectTarget(machine, pane.workspace_id, pane.tab_id, pane.pane_id, true), () => { fleet.resync(); void refresh(); });
const worktrees = new Worktrees(api, () => { const host = selectedHost(); return host?.connection === 'online' ? { machine: machineId, label: host.machine.label, workspace: workspaceId, cwd: snapshot.panes.find(pane => pane.pane_id === paneId)?.cwd } : undefined; }, (machine, pane) => { if (!pane) return; selectTarget(machine, pane.workspace_id, pane.tab_id, pane.pane_id, true); }, () => { fleet.resync(); void refresh(); });
const sidebarSplit = new SidebarSplit(element('rail-sections'), element('rail-divider'), value => settings.saveSidebarSplit(value));
const settings = new Settings(api, (value, nextColors) => {
  preferences = value; colors = nextColors; sidebarSplit.update(value.sidebarSectionPercent);
  surface.updatePreferences(value, nextColors);
  renderNavigation(); renderFleetNavigation();
});
element('settings-integrations').onclick = () => integrations.open();
element('settings-plugins').onclick = () => plugins.open();
element('settings').onclick = () => void settings.open();
function selectedHost() { return fleetState.hosts.find(host => host.machine.id === machineId); }
function selectHost(id: string) {
  if (!fleetState.hosts.some(host => host.machine.id === id)) { pendingHost = id; fleet.resync(); return; }
  if (machineId === id) return;
  pendingPane = undefined; rememberSelection(); const saved = selections.get(id);
  detach(); machineId = id; workspaceId = saved?.workspace || ''; tabId = saved?.tab || ''; paneId = saved?.pane || '';
  snapshot = selectedHost()?.snapshot || emptySnapshot(); closeRail(); if (!pendingPane || snapshot.panes.some(pane => pane.pane_id === pendingPane!.pane && pane.tab_id === pendingPane!.tab)) choose(); renderFleetNavigation(); surface.requestFocus(paneId);
}
function selectTarget(machine: string, workspace: string, tab: string, pane: string, waitForSnapshot = false) {
  if (waitForSnapshot) waitForPane(machine, pane, tab); else pendingPane = undefined;
  if (machineId !== machine) detach();
  if (waitForSnapshot) surface.waitForSelection();
  machineId = machine; workspaceId = workspace; tabId = tab; paneId = pane;
  snapshot = selectedHost()?.snapshot || emptySnapshot(); closeRail(); if (!pendingPane || snapshot.panes.some(pane => pane.pane_id === pendingPane!.pane && pane.tab_id === pendingPane!.tab)) choose(); renderFleetNavigation();
  surface.requestFocus(pane);
}
let pendingPaneTimer: ReturnType<typeof setTimeout> | undefined;
function waitForPane(machine: string, pane: string, tab: string, closedNotice = 'Requested pane closed before it could attach.') {
  clearTimeout(pendingPaneTimer);
  const pending = { machine, pane, tab }; pendingPane = pending;
  const inspect = async () => {
    if (pendingPane !== pending || machineId !== machine || !authenticated) return;
    try {
      if (selectedHost()?.connection === 'online') {
        const result = await api('/api/action', { machine, id: pane, action: 'pane.exists' });
        if (pendingPane !== pending || machineId !== machine) return;
        if (!result.exists) {
          pendingPane = undefined; paneId = ''; choose(); surface.requestFocus(paneId); renderFleetNavigation(); fleet.resync();
          status(`[NOTICE] ${closedNotice}`); return;
        }
      }
    } catch { /* Reconnect and authentication retain their existing UI. */ }
    if (pendingPane === pending && authenticated) pendingPaneTimer = setTimeout(inspect, 2000);
  };
  pendingPaneTimer = setTimeout(inspect, 500);
}
function applyFleet(state: FleetState, added?: Notice) {
  const previous = selectedHost()?.connection; fleetState = state;
  if (pendingHost && state.hosts.some(host => host.machine.id === pendingHost)) { const id = pendingHost; pendingHost = undefined; selectHost(id); }
  if (!selectedHost()?.machine.enabled && state.hosts.some(host => host.machine.enabled)) {
    detach(); machineId = state.hosts.find(host => host.machine.enabled)!.machine.id; workspaceId = ''; tabId = ''; paneId = '';
  }
  snapshot = selectedHost()?.snapshot || emptySnapshot();
  if (closingFocus?.machine === machineId && closingFocus.workspace === workspaceId && closingFocus.tab === tabId) {
    const nativeFocus = snapshot.layouts.find(layout => layout.tab_id === tabId)?.focused_pane_id;
    if (nativeFocus && nativeFocus !== paneId && snapshot.panes.some(pane => pane.pane_id === nativeFocus && pane.tab_id === tabId)) { paneId = nativeFocus; surface.requestFocus(paneId); }
  }
  if (pendingPane?.machine === machineId) { const target = snapshot.panes.find(pane => pane.pane_id === pendingPane!.pane && pane.tab_id === pendingPane!.tab); if (target) { workspaceId = target.workspace_id; tabId = target.tab_id; paneId = target.pane_id; } }
  if (!pendingPane || pendingPane.machine !== machineId || snapshot.panes.some(pane => pane.pane_id === pendingPane!.pane && pane.tab_id === pendingPane!.tab)) { pendingPane = undefined; choose(); }
  renderFleetNavigation(); contextMenu.refresh(); hostManager.update(state.hosts); activity.update(state, added);
  if (previous !== 'online' && selectedHost()?.connection === 'online') surface.recover();
}
function renderFleetNavigation() {
  const query = element<HTMLInputElement>('fleet-search').value.trim().toLowerCase();
  const match = (text: string) => text.toLowerCase().includes(query);
  navigation('hosts', fleetState.hosts.filter(host => match(host.machine.label + ' ' + (host.machine.target || ''))).map(host => ({ id: host.machine.id, label: host.machine.label, badge: host.connection.toUpperCase(), active: host.machine.id === machineId, disabled: !host.machine.enabled, title: `${host.machine.target || host.machine.label} / ${host.connection}${host.version ? ' / ' + host.version : ''}${host.detail ? ' / ' + host.detail : ''}`, select: () => selectHost(host.machine.id) })));
  const collapsed = new Set(preferences.collapsedWorkspaceGroups);
  navigation('workspaces', fleetState.hosts.flatMap(host => workspaceEntries(host.machine, host.snapshot?.workspaces || [], collapsed, host.machine.id === machineId ? workspaceId : '', query).map(entry => {
    const workspace = entry.workspace;
    return { id: `${host.machine.id}/${workspace.workspace_id}`, context: { kind: 'workspace' as const, machine: host.machine.id, id: workspace.workspace_id }, label: `${host.machine.label} / ${workspace.label || workspace.workspace_id}`, prefix: entry.indented ? entry.lastChild ? '└─ ' : '├─ ' : '', group: entry.group, badge: host.connection === 'online' ? entry.status.toUpperCase() : host.connection.toUpperCase(), active: host.machine.id === machineId && workspace.workspace_id === workspaceId, disabled: !host.machine.enabled, title: `${host.machine.label} / ${workspace.label || workspace.workspace_id}${workspace.worktree ? '\n' + workspace.worktree.checkout_path : ''}${entry.group ? '\n' + entry.group.members.length + ' workspaces in group' : ''}`, select: () => selectTarget(host.machine.id, workspace.workspace_id, '', '') };
  })));
  const filter = element<HTMLSelectElement>('agent-filter').value;
  const rank = (status: string) => status === 'blocked' ? 0 : status === 'working' ? 1 : 2;
  const agents = fleetState.hosts.flatMap(host => (host.snapshot?.agents || []).map(agent => ({ host, agent })))
    .filter(({ host, agent }) => (agent.agent || agent.name || agent.agent_status !== 'unknown') && match(`${host.machine.label} ${agent.name || ''} ${agent.agent || ''} ${agent.title || ''}`) && (filter === 'all' || filter === agent.agent_status || filter === 'done' && agent.agent_status === 'idle'))
    .sort((a, b) => preferences.agentSort === 'native' ? 0 : rank(a.agent.agent_status) - rank(b.agent.agent_status));
  navigation('agents', agents.map(({ host, agent }) => ({ id: `${host.machine.id}/${agent.pane_id}`, label: `${host.machine.label} / ${agent.name || agent.display_agent || agent.agent || agent.pane_id}`, badge: host.connection === 'online' ? agent.agent_status.toUpperCase() : host.connection.toUpperCase(), active: host.machine.id === machineId && agent.pane_id === paneId, disabled: !host.machine.enabled, title: agent.title || agent.cwd, select: () => selectTarget(host.machine.id, agent.workspace_id, agent.tab_id, agent.pane_id) })));
  const current = selectedHost(); const online = current?.connection === 'online';
  element<HTMLButtonElement>('settings-integrations').disabled = !online;
  element<HTMLButtonElement>('settings-plugins').disabled = !online;
  element<HTMLButtonElement>('create').disabled = !online || !!pendingPane;
  const connected = fleetState.hosts.filter(host => host.connection === 'online').length;
  status(`${online ? '[OK]' : '[' + (current?.connection || 'connecting').toUpperCase() + ']'} ${current?.machine.label || ''} / ${connected}/${fleetState.hosts.filter(host => host.machine.enabled).length} HOSTS ONLINE / ${snapshot.workspaces.length} WORKSPACES / ${snapshot.panes.length} PANES`);
  if (element<HTMLDialogElement>('command-dialog').open) refreshCommands();
}

async function api(path: string, data?: object): Promise<any> {
  const res = await fetch(path, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  const value = await res.json();
  if (res.status === 401) { authenticated = false; fleet.stop(); detach(); for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) if (dialog.id !== 'boot') dialog.close(); element('settings').hidden = true; element('access-token').hidden = true; element('sessions').hidden = true; element<HTMLDialogElement>('sessions-dialog').close(); element<HTMLDialogElement>('token-dialog').close(); if (path !== '/api/login') boot.requireAuthentication(); }
  if (!res.ok) throw new Error(value.error || `Request failed (${res.status})`);
  return value;
}
interface NavigationItem { id: string; label: string; active: boolean; select: () => void; disabled?: boolean; title?: string; badge?: string; prefix?: string; group?: { key: string; collapsed: boolean }; context?: { kind: 'workspace' | 'tab' | 'pane'; machine: string; id: string } }
async function toggleWorkspaceGroup(key: string, collapsed: boolean) {
  if (pendingGroups.has(key)) return;
  pendingGroups.add(key); renderFleetNavigation();
  let failure: string | undefined;
  try { await settings.saveWorkspaceGroup(key, collapsed); }
  catch (error) { failure = (error as Error).message; }
  finally { pendingGroups.delete(key); renderFleetNavigation(); }
  if (failure) status(`[ERROR] ${failure}`);
}
function navigation(id: string, items: NavigationItem[]) {
  const parent = element(id);
  const existing = new Map([...parent.querySelectorAll<HTMLButtonElement>('button[data-id]')].map(node => [node.dataset.id, node]));
  items.forEach((item, index) => {
    const node = existing.get(item.id) || document.createElement('button');
    existing.delete(item.id);
    node.dataset.id = item.id;
    const text = (item.prefix || '') + item.label;
    if (node.textContent !== text) node.textContent = text;
    node.dataset.badge = item.badge || ''; node.setAttribute('aria-label', item.label);
    node.classList.toggle('active', item.active); node.disabled = !!item.disabled;
    node.title = item.title || item.label; node.onclick = item.select;
    node.oncontextmenu = item.context ? event => { event.preventDefault(); openNavigationMenu(node, item.context!, { x: event.clientX, y: event.clientY }); } : null;
    node.onkeydown = item.context ? event => {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openNavigationMenu(node, item.context!); }
      else if (item.group && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); void toggleWorkspaceGroup(item.group.key, event.key === 'ArrowLeft'); }
    } : null;
    if (item.context) node.setAttribute('aria-haspopup', 'menu'); else node.removeAttribute('aria-haspopup');
    let row: HTMLElement = node;
    if (id === 'workspaces') {
      row = node.parentElement?.classList.contains('workspace-row') ? node.parentElement : document.createElement('div');
      row.className = 'workspace-row'; if (node.parentElement !== row) row.append(node);
      let toggle = row.querySelector<HTMLButtonElement>('.workspace-group-toggle');
      if (item.group) {
        if (!toggle) { toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'workspace-group-toggle'; row.append(toggle); }
        toggle.textContent = item.group.collapsed ? '▸' : '▾'; toggle.setAttribute('aria-expanded', String(!item.group.collapsed));
        toggle.setAttribute('aria-label', `${item.group.collapsed ? 'Expand' : 'Collapse'} worktree group ${item.label}`);
        toggle.title = `${item.group.collapsed ? 'Expand' : 'Collapse'} worktree group`; toggle.disabled = !!item.disabled;
        toggle.setAttribute('aria-disabled', String(pendingGroups.has(item.group.key) || !!item.disabled));
        toggle.onclick = () => { void toggleWorkspaceGroup(item.group!.key, !item.group!.collapsed); };
      } else toggle?.remove();
    }
    if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] || null);
  });
  for (const node of existing.values()) { if (node.parentElement?.classList.contains('workspace-row')) node.parentElement.remove(); else node.remove(); }
}
function renderNavigation() {
  element('tabs').hidden = preferences.hideSingleTab && snapshot.tabs.filter(t => t.workspace_id === workspaceId).length <= 1;
  navigation('tabs', snapshot.tabs.filter(t => t.workspace_id === workspaceId).map(t => ({ id: t.tab_id, context: { kind: 'tab', machine: machineId, id: t.tab_id }, label: t.label || t.tab_id, active: t.tab_id === tabId, select: () => { tabId = t.tab_id; paneId = ''; choose(); } })));
  navigation('panes', snapshot.panes.filter(p => p.tab_id === tabId).map(p => ({ id: p.pane_id, context: { kind: 'pane', machine: machineId, id: p.pane_id }, label: `${p.label || p.title || p.pane_id} [${p.agent_status.toUpperCase()}]`, active: p.pane_id === paneId, select: () => selectPane(p.pane_id) })));
  updateShieldBounds();
  element<HTMLButtonElement>('new-tab').disabled = !workspaceId || !!pendingPane || selectedHost()?.connection !== 'online';
  for (const id of ['split', 'takeover', 'close', 'pane-actions']) element<HTMLButtonElement>(id).disabled = !paneId || !!pendingPane || selectedHost()?.connection !== 'online';
}
function updateShieldBounds() {
  const terminal = element('terminal');
  element('shield').style.top = `${terminal.offsetTop}px`;
  element('shield').style.bottom = `${element('surface').clientHeight - terminal.offsetTop - terminal.offsetHeight}px`;
}
new ResizeObserver(updateShieldBounds).observe(element('terminal'));
function choose() {
  // Connecting hosts have no snapshot yet. Preserve deep links and saved selection
  // until the native server can authoritatively reconcile those IDs.
  if (!selectedHost()?.snapshot) { renderNavigation(); element('shield').textContent = selectedHost()?.detail || 'Connecting to host...'; return; }
  const restoreFocus = !!paneId && !snapshot.panes.some(p => p.pane_id === paneId);
  if (!snapshot.workspaces.some(w => w.workspace_id === workspaceId)) workspaceId = snapshot.workspaces.find(w => w.workspace_id === snapshot.focused_workspace_id)?.workspace_id || snapshot.workspaces[0]?.workspace_id || '';
  if (!snapshot.tabs.some(t => t.tab_id === tabId && t.workspace_id === workspaceId)) {
    const nativeTab = snapshot.workspaces.find(w => w.workspace_id === workspaceId)?.active_tab_id;
    tabId = snapshot.tabs.find(t => t.workspace_id === workspaceId && t.tab_id === nativeTab)?.tab_id || snapshot.tabs.find(t => t.workspace_id === workspaceId)?.tab_id || '';
  }
  if (!snapshot.panes.some(p => p.pane_id === paneId && p.tab_id === tabId)) {
    const nativePane = snapshot.layouts.find(layout => layout?.tab_id === tabId)?.focused_pane_id;
    paneId = snapshot.panes.find(p => p.tab_id === tabId && p.pane_id === nativePane)?.pane_id || snapshot.panes.find(p => p.tab_id === tabId)?.pane_id || '';
  }
  renderNavigation(); rememberSelection();
  surface.sync(machineId, tabId, paneId, snapshot, selectedHost()?.connection === 'online');
  if (restoreFocus) surface.requestFocus(paneId);
  if (!paneId && selectedHost()?.connection === 'online') { detach(); element('shield').textContent = 'No panes. Create a workspace to start a session.'; }
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const session = await api('/api/session');
    authenticated = true; element('settings').hidden = false; element('sessions').hidden = false; element('access-token').hidden = !session.canGenerateToken;
    await settings.refresh();
    fleet.start();
    const state = await api('/api/fleet');
    if (state.revision >= fleetState.revision || !fleetState.hosts.length) applyFleet(state);
  } catch (error) { status(`[OFFLINE] ${(error as Error).message}`); }
  finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
}
function detach() { surface.clear(); }
async function attach(takeover = false) { if (selectedHost()?.connection === 'online') { choose(); await surface.active?.connect(takeover); } }
async function action(action: string, id?: string, extra: object = {}, selected = machineId) {
  const interaction = interactionRevision, source = { machine: selected, workspace: workspaceId, tab: tabId };
  try {
    const response = await api('/api/action', { machine: selected, action, id, ...extra });
    const result = response.move_result || response.focus || response.swap || response.zoom || response.resize || response;
    if (machineId !== selected) return;
    if (action === 'pane.close' && interactionRevision === interaction && workspaceId === source.workspace && tabId === source.tab) closingFocus = source;
    const created = result.root_pane || result.pane;
    if (created && action !== 'pane.close') {
      workspaceId = created.workspace_id; tabId = created.tab_id; paneId = created.pane_id; waitForPane(selected, paneId, tabId, action === 'pane.edit_scrollback' ? 'The editor terminal closed before it could attach. Graphical editors may continue on the host.' : undefined); surface.waitForSelection(); if (interactionRevision === interaction) surface.requestFocus(paneId); renderNavigation(); renderFleetNavigation();
    }
    if (result.focused_pane_id) { paneId = result.focused_pane_id; if (interactionRevision === interaction) surface.requestFocus(paneId); }
    closeRail(); await refresh(); surface.refresh(); fleet.resync();
    if (response.notice) status(`[NOTICE] ${response.notice}`);
  }
  catch (error) { status(`[ERROR] ${(error as Error).message}`); }
}
element('refresh').onclick = () => { void api('/api/hosts/retry', { id: machineId }).then(refresh).catch(error => status(error.message)); fleet.resync(); if (paneId) void attach(); };
element('create').onclick = () => void action('workspace.create', undefined, workspaceId ? { source: workspaceId } : {});
element('new-tab').onclick = () => void action('tab.create', workspaceId);
element('split').onclick = () => void action('pane.split', paneId, { direction: 'right' });
element('takeover').onclick = () => void attach(true);
element('close').onclick = () => { if (!preferences.confirmClose || confirm('Close this pane and end its running process?')) void action('pane.close', paneId); };
element('logout').onclick = async () => { try { await api('/api/logout', {}); authenticated = false; fleet.stop(); detach(); boot.requireAuthentication(); } catch (error) { status(String(error)); } };
initializeAccount(api, refresh);
element('manage-hosts').onclick = () => hostManager.open();
element('activity').onclick = () => activity.open();
element('fleet-search').oninput = () => renderFleetNavigation();
element('agent-filter').onchange = () => renderFleetNavigation();
type MenuTarget = NonNullable<NavigationItem['context']>;
function closeWorkspace(machine: string, id: string) {
  const host = fleetState.hosts.find(host => host.machine.id === machine && host.machine.enabled && host.connection === 'online');
  const workspace = host?.snapshot?.workspaces.find(workspace => workspace.workspace_id === id);
  if (!host?.snapshot || !workspace) return;
  const group = workspaceGroup(host.snapshot.workspaces, workspace);
  const message = group ? `Close this worktree group and end the running processes in all ${group.length} workspaces?\n${group.map(item => item.label || item.workspace_id).join('\n')}\nThe Git checkouts will remain on the host.` : 'Close this workspace and end all its running processes?';
  if (!preferences.confirmClose || confirm(message)) void action('workspace.close', id, group ? { close_group: true } : {}, machine);
}
function openNavigationMenu(origin: HTMLElement, target: MenuTarget, position?: { x: number; y: number }) {
  const current = () => {
    const host = fleetState.hosts.find(host => host.machine.id === target.machine && host.machine.enabled && host.connection === 'online');
    return target.kind === 'workspace' ? host?.snapshot?.workspaces.find(item => item.workspace_id === target.id) : target.kind === 'tab' ? host?.snapshot?.tabs.find(item => item.tab_id === target.id) : host?.snapshot?.panes.find(item => item.pane_id === target.id);
  };
  const item = current(); if (!item) return;
  const invoke = (name: string, id = target.id, params = {}) => { void action(name, id, params, target.machine); };
  const items: ContextAction[] = [
    { label: 'RENAME', run: () => rename(target.kind + '.rename', target.id, current()?.label || '', target.machine) },
  ];
  if (target.kind === 'workspace') {
    const workspace = item as Workspace, host = fleetState.hosts.find(host => host.machine.id === target.machine)!;
    const group = workspaceGroup(host.snapshot!.workspaces, workspace);
    const openWorktrees = (intent: 'create' | 'open' | 'remove') => {
      const workspace = current() as Workspace | undefined;
      if (workspace) void worktrees.open({ machine: target.machine, label: host.machine.label, workspace: target.id, cwd: workspace.worktree?.checkout_path }, intent);
    };
    if (workspace.worktree?.is_linked_worktree) items.push({ label: 'DELETE WORKTREE CHECKOUT...', run: () => openWorktrees('remove') });
    else if (workspace.worktree) items.push({ label: 'NEW WORKTREE', run: () => openWorktrees('create') }, { label: 'OPEN WORKTREE...', run: () => openWorktrees('open') });
    if (group) {
      const key = workspaceGroupKey(host.machine, workspace.worktree!.repo_key), collapsed = preferences.collapsedWorkspaceGroups.includes(key);
      items.push({ label: collapsed ? 'EXPAND GROUP' : 'COLLAPSE GROUP', run: () => { void toggleWorkspaceGroup(key, !collapsed); } });
    }
    items.push({ label: group ? 'CLOSE GROUP' : 'CLOSE WORKSPACE', run: () => closeWorkspace(target.machine, target.id) });
  }
  if (target.kind === 'tab') {
    const tab = item as Snapshot['tabs'][number];
    items.unshift({ label: 'NEW TAB', run: () => invoke('tab.create', tab.workspace_id) });
  }
  const focusedPane = target.machine === machineId ? paneId : undefined;
  if (target.kind === 'pane' && focusedPane && focusedPane !== target.id) items.push({ label: 'SWAP WITH FOCUSED PANE', run: () => invoke('pane.swap', target.id, { source: focusedPane, target: target.id }) });
  if (target.kind === 'pane' && item.label) items.push({ label: 'CLEAR PANE NAME', run: () => invoke('pane.rename', target.id, { label: null }) });
  if (target.kind === 'pane') items.push(
    { label: 'SPLIT RIGHT', run: () => invoke('pane.split', target.id, { direction: 'right' }) },
    { label: 'SPLIT DOWN', run: () => invoke('pane.split', target.id, { direction: 'down' }) },
    { label: 'ZOOM / RESTORE', run: () => invoke('pane.zoom', target.id, { mode: 'toggle' }) },
  );
  if (target.kind !== 'workspace') items.push({ label: 'CLOSE ' + target.kind.toUpperCase(), run: () => { if (!preferences.confirmClose || confirm(`Close this ${target.kind} and end its running processes?`)) invoke(target.kind + '.close'); } });
  contextMenu.open(origin, `${target.kind.toUpperCase()} ${item.label || target.id}`, items, () => authenticated && !!current(), position);
}
for (const type of ['contextmenu', 'keydown'] as const) element('terminal').addEventListener(type, event => {
  const origin = (event.target as Element).closest<HTMLElement>('.pane-title'); if (!origin) return;
  if (event instanceof KeyboardEvent && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const id = origin.closest<HTMLElement>('.terminal-pane')?.dataset.pane; if (!id) return;
  event.preventDefault(); openNavigationMenu(origin, { kind: 'pane', machine: machineId, id }, event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined);
});
interface Command { label: string; disabled?: boolean; run(): void }
let commands: Command[] = [];
let renameTarget: { machine: string; action: string; id: string } | undefined;
function rename(action: string, id: string, label: string, machine = machineId) {
  renameTarget = { machine, action, id }; element('rename-title').textContent = action.replace('.', ' ').toUpperCase();
  element<HTMLInputElement>('rename-value').value = label; element('rename-error').textContent = '';
  element<HTMLDialogElement>('rename-dialog').showModal(); element<HTMLInputElement>('rename-value').focus();
}
element('rename-cancel').onclick = () => element<HTMLDialogElement>('rename-dialog').close();
element<HTMLFormElement>('rename-form').onsubmit = async event => {
  event.preventDefault(); if (!renameTarget) return;
  const button = element('rename-form').querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
  try {
    await api('/api/action', { ...renameTarget, [renameTarget.action === 'agent.rename' ? 'name' : 'label']: element<HTMLInputElement>('rename-value').value });
    element<HTMLDialogElement>('rename-dialog').close(); fleet.resync();
  } catch (error) { element('rename-error').textContent = (error as Error).message; }
  finally { button.disabled = false; }
};
let agentTarget: { machine: string; id: string } | undefined;
function openAgent(machine = machineId, pane = paneId) {
  const host = fleetState.hosts.find(host => host.machine.id === machine), agent = host?.snapshot?.agents.find(agent => agent.pane_id === pane);
  agentTarget = { machine, id: pane };
  element('agent-context').textContent = `${host?.machine.label || machine} / ${pane} [${agent?.agent_status.toUpperCase() || 'NO AGENT'}]`;
  element<HTMLInputElement>('agent-kind').value = agent?.agent || 'claude'; element<HTMLInputElement>('agent-name').value = agent?.name || `agent-${pane.replaceAll(':', '-')}`;
  element<HTMLTextAreaElement>('agent-prompt').value = ''; element('agent-error').textContent = '';
  element('agent-start-form').hidden = !!agent?.agent && agent.agent_status !== 'unknown';
  element('agent-prompt-form').hidden = !agent?.agent;
  element<HTMLDialogElement>('agent-dialog').showModal();
}
element('agent-done').onclick = () => element<HTMLDialogElement>('agent-dialog').close();
for (const [formId, actionName] of [['agent-start-form', 'agent.start'], ['agent-prompt-form', 'agent.prompt']] as const) {
  element<HTMLFormElement>(formId).onsubmit = async event => {
    event.preventDefault(); if (!agentTarget) return;
    const button = element(formId).querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
    element('agent-error').textContent = actionName === 'agent.start' ? 'Starting agent. Herdr is waiting for its interactive prompt...' : '';
    try {
      await api('/api/action', { ...agentTarget, action: actionName, ...(actionName === 'agent.start' ? { kind: element<HTMLInputElement>('agent-kind').value, name: element<HTMLInputElement>('agent-name').value } : { text: element<HTMLTextAreaElement>('agent-prompt').value }) });
      element<HTMLDialogElement>('agent-dialog').close(); fleet.resync();
    } catch (error) { element('agent-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  };
}
function refreshCommands() {
  const machine = machineId, workspace = workspaceId, tab = tabId, pane = paneId;
  const online = selectedHost()?.connection === 'online' && !pendingPane;
  commands = [
    { label: 'Manage hosts / add an SSH host', run: () => hostManager.open() },
    { label: 'Fleet activity and notifications', run: () => activity.open() },
    ...([1, -1] as const).map(direction => ({ label: `${direction === 1 ? 'Next' : 'Previous'} agent needing attention`, disabled: !attentionTarget(fleetState, machine, pane, direction), run: () => {
      const target = attentionTarget(fleetState, machine, pane, direction); if (!target) return;
      selectTarget(target.machine, target.workspace, target.tab, target.pane); surface.requestFocus(target.pane);
    } })),
    { label: 'Host: runtime settings', disabled: !online, run: () => runtimeSettings.open() },
    { label: 'Integrations: agent hooks and readiness', disabled: !online, run: () => integrations.open() },
    { label: 'Plugins: management, actions, panes and logs', disabled: !online, run: () => plugins.open() },
    { label: 'Terminal: copy mode (native scrollback)', disabled: !online || !surface.active?.ready, run: () => { void surface.active?.copyMode.start(); } },
    { label: 'Terminal: search native scrollback', disabled: !online || !surface.active?.ready, run: () => { void surface.active?.copyMode.start(true); } },
    { label: 'Terminal: open scrollback in host editor', disabled: !online || !pane, run: () => { void action('pane.edit_scrollback', pane, {}, machine); } },
    { label: 'Worktrees: list, create, open or remove', disabled: !online, run: () => worktrees.open() },
    { label: 'Create workspace', disabled: !online, run: () => { void action('workspace.create', undefined, workspace ? { source: workspace } : {}, machine); } },
    { label: 'Create tab', disabled: !workspace || !online, run: () => { void action('tab.create', workspace, {}, machine); } },
    { label: 'Split right (Ctrl/Cmd+D)', disabled: !pane || !online, run: () => { void action('pane.split', pane, { direction: 'right' }, machine); } },
    { label: 'Split down (Ctrl/Cmd+Shift+D)', disabled: !pane || !online, run: () => { void action('pane.split', pane, { direction: 'down' }, machine); } },
    { label: 'Zoom / restore pane', disabled: !pane || !online, run: () => { void action('pane.zoom', pane, { mode: 'toggle' }, machine); } },
    ...(['left', 'right', 'up', 'down'] as const).flatMap(direction => [
      { label: `Focus pane ${direction}`, disabled: !pane || !online, run: () => { void action('pane.focus_direction', pane, { direction }, machine); } },
      { label: `Swap pane ${direction}`, disabled: !pane || !online, run: () => { void action('pane.swap', pane, { direction }, machine); } },
      { label: `Resize pane ${direction}`, disabled: !pane || !online, run: () => { void action('pane.resize', pane, { direction }, machine); } },
    ]),
    { label: 'Move pane to new tab', disabled: !pane || !online, run: () => { void action('pane.move', pane, { destination: 'new_tab' }, machine); } },
    { label: 'Move pane to new workspace', disabled: !pane || !online, run: () => { void action('pane.move', pane, { destination: 'new_workspace' }, machine); } },
    ...snapshot.tabs.filter(item => item.tab_id !== tab).map(item => ({ label: `Move pane to tab: ${item.label || item.tab_id}`, disabled: !pane || !online, run: () => { void action('pane.move', pane, { destination: 'tab', tab: item.tab_id, direction: 'right' }, machine); } })),
    ...(['earlier', 'later'] as const).flatMap((direction, index) => {
      const tabs = snapshot.tabs.filter(item => item.workspace_id === workspace), tabIndex = tabs.findIndex(item => item.tab_id === tab), workspaceIndex = snapshot.workspaces.findIndex(item => item.workspace_id === workspace);
      return [
        { label: `Move tab ${direction}`, disabled: !online || (index === 0 ? tabIndex <= 0 : tabIndex >= tabs.length - 1), run: () => { void action('tab.move', tab, { index: tabIndex + (index === 0 ? -1 : 2) }, machine); } },
        { label: `Move workspace ${direction}`, disabled: !online || (index === 0 ? workspaceIndex <= 0 : workspaceIndex >= snapshot.workspaces.length - 1), run: () => { void action('workspace.move', workspace, { index: workspaceIndex + (index === 0 ? -1 : 2) }, machine); } },
      ];
    }),
    { label: 'Start or prompt agent', disabled: !pane || !online, run: () => openAgent(machine, pane) },
    { label: 'Rename workspace', disabled: !workspace || !online, run: () => rename('workspace.rename', workspace, snapshot.workspaces.find(item => item.workspace_id === workspace)?.label || '', machine) },
    { label: 'Rename tab', disabled: !tab || !online, run: () => rename('tab.rename', tab, snapshot.tabs.find(item => item.tab_id === tab)?.label || '', machine) },
    { label: 'Rename pane', disabled: !pane || !online, run: () => rename('pane.rename', pane, snapshot.panes.find(item => item.pane_id === pane)?.label || '', machine) },
    { label: 'Clear pane name', disabled: !pane || !online || !snapshot.panes.find(item => item.pane_id === pane)?.label, run: () => { void action('pane.rename', pane, { label: null }, machine); } },
    { label: 'Rename agent', disabled: !pane || !online || !snapshot.agents.some(agent => agent.pane_id === pane && agent.agent), run: () => rename('agent.rename', pane, snapshot.agents.find(agent => agent.pane_id === pane)?.name || '', machine) },
    { label: 'Close pane and end its process', disabled: !pane || !online, run: () => { if (!preferences.confirmClose || confirm('Close this pane and end its running process?')) void action('pane.close', pane, {}, machine); } },
    { label: 'Close tab and end its processes', disabled: !tab || !online, run: () => { if (!preferences.confirmClose || confirm('Close this tab and end all its running processes?')) void action('tab.close', tab, {}, machine); } },
    { label: workspaceGroup(snapshot.workspaces, snapshot.workspaces.find(item => item.workspace_id === workspace)) ? 'Close worktree group and end its processes' : 'Close workspace and end its processes', disabled: !workspace || !online, run: () => closeWorkspace(machine, workspace) },
    ...navigationTargets(fleetState).map(target => ({ label: target.label, disabled: target.disabled, run: () => {
      const current = resolveNavigationTarget(fleetState, target);
      if (!current) { status('[WARN] Navigation target is no longer available.'); return; }
      selectTarget(current.machine, current.workspace, current.tab, current.pane);
      if (paneId) surface.requestFocus(paneId);
    } })),
    ...fleetState.hosts.map(host => ({ label: `Host: ${host.machine.label} [${host.connection}]`, disabled: !host.machine.enabled, run: () => selectHost(host.machine.id) })),
    ...fleetState.hosts.flatMap(host => (host.snapshot?.agents || []).filter(agent => agent.agent || agent.name).map(agent => ({ label: `Agent: ${host.machine.label} / ${agent.name || agent.agent} [${agent.agent_status}]`, disabled: !host.machine.enabled, run: () => selectTarget(host.machine.id, agent.workspace_id, agent.tab_id, agent.pane_id) }))),
  ];
  renderCommands();
}
function openCommands() {
  element<HTMLInputElement>('command-search').value = ''; refreshCommands(); element<HTMLDialogElement>('command-dialog').showModal(); element('command-search').focus();
}
function renderCommands() {
  const query = element<HTMLInputElement>('command-search').value.toLowerCase(); const parent = element('command-list');
  const focused = parent.contains(document.activeElement) ? document.activeElement?.textContent : undefined; const scroll = parent.scrollTop; parent.replaceChildren();
  for (const command of commands.filter(command => command.label.toLowerCase().includes(query))) {
    const button = document.createElement('button'); button.textContent = command.label; button.disabled = !!command.disabled;
    button.onclick = () => { element<HTMLDialogElement>('command-dialog').close(); command.run(); }; parent.append(button);
    if (focused && command.label === focused) button.focus({ preventScroll: true });
  }
  if (!parent.childElementCount) { const empty = document.createElement('p'); empty.setAttribute('role', 'status'); empty.textContent = 'No matching actions or destinations.'; parent.append(empty); }
  if (focused && !parent.contains(document.activeElement)) element('command-search').focus({ preventScroll: true });
  parent.scrollTop = scroll;
}
element('commands').onclick = openCommands; element('pane-actions').onclick = openCommands;
element('command-done').onclick = () => element<HTMLDialogElement>('command-dialog').close();
element('command-search').oninput = renderCommands;
element('command-search').onkeydown = event => {
  const buttons = [...element('command-list').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); (event.key === 'ArrowDown' ? buttons[0] : buttons.at(-1))?.focus(); }
  else if (event.key === 'Enter') { event.preventDefault(); buttons[0]?.click(); }
};
element('command-list').onkeydown = event => {
  const buttons = [...element('command-list').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (index < 0) return;
  let next: number;
  if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + 1);
  else if (event.key === 'ArrowUp') next = index - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault();
  if (next < 0) element('command-search').focus(); else buttons[next]?.focus();
};
document.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('.copy-layer, .copy-toolbar') && event.key.toLowerCase() !== 'k') return;
  if (!authenticated || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); if (!document.querySelector('dialog[open]')) openCommands(); }
  else if (event.key.toLowerCase() === 'd' && !document.querySelector('dialog[open], .context-menu:not([hidden])') && paneId && selectedHost()?.connection === 'online') { event.preventDefault(); event.stopPropagation(); if (!pendingPane) void action('pane.split', paneId, { direction: event.shiftKey ? 'down' : 'right' }); }
}, true);
async function start() {
  const config = fetch('/api/auth').then(response => { if (!response.ok) throw new Error('Sign-in unavailable'); return response.json(); });
  const configured = config.then(value => ({ value }), () => ({ value: { passwordEnabled: false } }));
  await boot.ready;
  const { value } = await configured;
  boot.configure(value.passwordEnabled);
  await refresh();
  if (authenticated) await boot.complete();
  else boot.requireAuthentication();
}
function closeRail() { app.classList.remove('hosts-open'); element('host-toggle').setAttribute('aria-expanded', 'false'); }
element('host-toggle').onclick = () => { const open = app.classList.toggle('hosts-open'); element('host-toggle').setAttribute('aria-expanded', String(open)); };
function viewport() {
  const height = visualViewport?.height || innerHeight;
  document.documentElement.style.setProperty('--viewport', `${height}px`);
  app.classList.toggle('keyboard-open', innerWidth <= 700 && height < innerHeight * .75);
}
visualViewport?.addEventListener('resize', viewport); viewport();
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => { void refresh(); if (paneId) void attach(); });
setInterval(() => { if (authenticated && !document.hidden) void refresh(); }, 30_000);
void start();
