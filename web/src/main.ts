import type { Terminal } from 'ghostty-web';
import { RETRO_BOOT_PROFILES } from './wmux/retro-boot-profiles';
import './style.css';

interface Machine { id: string; label: string; enabled: boolean; target?: string }
interface Workspace { workspace_id: string; label: string; agent_status: string }
interface Tab { tab_id: string; workspace_id: string; label: string }
interface Pane { pane_id: string; workspace_id: string; tab_id: string; label?: string; title?: string; agent_status: string; cwd?: string }
interface Snapshot { workspaces: Workspace[]; tabs: Tab[]; panes: Pane[] }
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header><button id="host-toggle" aria-expanded="false" aria-controls="rail">[H] HOSTS</button><strong>werdr<span> / WEB TERMINAL</span></strong><button id="logout">[X] SIGN OUT</button></header>
<main><aside id="rail"><div class="section">HOSTS <button id="refresh" aria-label="Refresh hosts">[R]</button></div><nav id="hosts" aria-label="Hosts"></nav><div class="section">WORKSPACES <button id="create" aria-label="Create workspace">[+]</button></div><nav id="workspaces" aria-label="Workspaces"></nav></aside>
<section id="surface"><nav id="tabs" aria-label="Tabs"></nav><nav id="panes" aria-label="Panes"></nav><div id="terminal"></div><div id="shield" role="status">Select a workspace to attach.</div></section></main>
<footer><span id="status" role="status">[WAIT] CONNECTING</span><div><button id="new-tab">[+] TAB</button><button id="split">[|] SPLIT</button><button id="takeover">TAKE CONTROL</button><button id="close">CLOSE PANE</button></div></footer>
<dialog id="login"><form><div id="boot" aria-hidden="true"></div><label class="boot-options">BOOT SCREEN<select id="boot-profile"></select></label><h1>werdr</h1><p>Herdr sessions. Anywhere on your network.</p><label>ACCESS TOKEN<input id="token" type="password" required autocomplete="current-password"></label><button type="submit">[ENTER] CONNECT</button><p id="login-error" role="alert"></p></form></dialog>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const login = element<HTMLDialogElement>('login');
const status = (text: string) => { element('status').textContent = text; };
let machineId = 'local', workspaceId = '', tabId = '', paneId = '';
let snapshot: Snapshot = { workspaces: [], tabs: [], panes: [] };
let authenticated = false, refreshing = false, refreshAgain = false, terminal: Terminal | undefined, socket: WebSocket | undefined;
let disposeTerminal: (() => void) | undefined, generation = 0, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let ghostty: Promise<typeof import('ghostty-web')> | undefined;
function loadGhostty() {
  return ghostty ??= import('ghostty-web').then(async library => { await library.init(); return library; }).catch(error => { ghostty = undefined; throw error; });
}

async function api(path: string, data?: object): Promise<any> {
  const res = await fetch(path, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  const value = await res.json();
  if (res.status === 401) { authenticated = false; detach(); if (!login.open) login.showModal(); }
  if (!res.ok) throw new Error(value.error || `Request failed (${res.status})`);
  return value;
}
interface NavigationItem { id: string; label: string; active: boolean; select: () => void; disabled?: boolean; title?: string }
function navigation(id: string, items: NavigationItem[]) {
  const parent = element(id);
  const existing = new Map([...parent.querySelectorAll('button')].map(node => [node.dataset.id, node]));
  items.forEach((item, index) => {
    const node = existing.get(item.id) || document.createElement('button');
    existing.delete(item.id);
    node.dataset.id = item.id;
    if (node.textContent !== item.label) node.textContent = item.label;
    node.classList.toggle('active', item.active); node.disabled = !!item.disabled;
    node.title = item.title || item.label; node.onclick = item.select;
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  for (const node of existing.values()) node.remove();
}
function renderNavigation() {
  navigation('workspaces', snapshot.workspaces.map(w => ({ id: w.workspace_id, label: `${w.label || w.workspace_id} [${w.agent_status.toUpperCase()}]`, active: w.workspace_id === workspaceId, select: () => {
    workspaceId = w.workspace_id; tabId = ''; paneId = ''; closeRail(); choose();
  }})));
  navigation('tabs', snapshot.tabs.filter(t => t.workspace_id === workspaceId).map(t => ({ id: t.tab_id, label: t.label || t.tab_id, active: t.tab_id === tabId, select: () => { tabId = t.tab_id; paneId = ''; choose(); } })));
  navigation('panes', snapshot.panes.filter(p => p.tab_id === tabId).map(p => ({ id: p.pane_id, label: `${p.label || p.title || p.pane_id} [${p.agent_status.toUpperCase()}]`, active: p.pane_id === paneId, select: () => { if (paneId === p.pane_id) return; paneId = p.pane_id; renderNavigation(); void attach(); } })));
  element<HTMLButtonElement>('new-tab').disabled = !workspaceId;
  for (const id of ['split', 'takeover', 'close']) element<HTMLButtonElement>(id).disabled = !paneId;
}
function choose() {
  if (!snapshot.workspaces.some(w => w.workspace_id === workspaceId)) workspaceId = snapshot.workspaces[0]?.workspace_id || '';
  if (!snapshot.tabs.some(t => t.tab_id === tabId && t.workspace_id === workspaceId)) tabId = snapshot.tabs.find(t => t.workspace_id === workspaceId)?.tab_id || '';
  const old = paneId;
  if (!snapshot.panes.some(p => p.pane_id === paneId && p.tab_id === tabId)) paneId = snapshot.panes.find(p => p.tab_id === tabId)?.pane_id || '';
  renderNavigation();
  if (old !== paneId || (!terminal && paneId)) void attach();
  if (!paneId) { detach(); element('shield').textContent = 'No panes. Create a workspace to start a session.'; }
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  if (document.hidden) return;
  refreshing = true;
  const selected = machineId;
  try {
    const { machines }: { machines: Machine[] } = await api('/api/machines');
    authenticated = true;
    navigation('hosts', machines.map(m => ({ id: m.id, label: `${m.label}${m.enabled ? '' : ' [DISABLED]'}`, active: m.id === machineId, disabled: !m.enabled, title: m.target || 'Gateway host', select: () => {
        if (machineId === m.id) return;
        detach(); machineId = m.id; workspaceId = ''; tabId = ''; paneId = ''; snapshot = { workspaces: [], tabs: [], panes: [] }; renderNavigation(); closeRail();
        void refresh();
      }})));
    const result = await api(`/api/snapshot?machine=${encodeURIComponent(selected)}`);
    if (machineId !== selected) return;
    snapshot = result.snapshot;
    choose(); status(`[OK] ${snapshot.workspaces.length} WORKSPACES / ${snapshot.panes.length} PANES`);
  } catch (error) {
    status(`[OFFLINE] ${(error as Error).message}`);
  } finally {
    refreshing = false;
    if (selected !== machineId || refreshAgain) { refreshAgain = false; void refresh(); }
  }
}
function detach(resetRetry = true) {
  generation++; clearTimeout(reconnectTimer); if (resetRetry) reconnectAttempt = 0;
  socket?.close(); socket = undefined; disposeTerminal?.(); disposeTerminal = undefined; terminal = undefined;
  element('terminal').replaceChildren(); element('shield').hidden = false;
}
async function attach(takeover = false, retry = false) {
  detach(!retry); if (!paneId) return;
  const epoch = generation;
  const selectedMachine = machineId, selectedPane = paneId;
  element('shield').textContent = 'Attaching to Herdr...';
  let library: typeof import('ghostty-web');
  try { library = await loadGhostty(); } catch { status('[ERROR] Terminal renderer could not load'); return; }
  if (epoch !== generation) return;
  const term = new library.Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 14, cursorBlink: false, theme: { background: '#14191b', foreground: '#d1ddd8' } });
  terminal = term;
  const fit = new library.FitAddon(); term.loadAddon(fit); term.open(element('terminal')); fit.fit();
  const params = new URLSearchParams({ machine: selectedMachine, pane: selectedPane, cols: String(term.cols), rows: String(term.rows), takeover: takeover ? '1' : '0' });
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal?${params}`); socket = ws;
  const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  let applyingFrame = false;
  const input = term.onData(text => send({ type: 'terminal.input', text }));
  const resize = term.onResize(({ cols, rows }) => { if (!applyingFrame) send({ type: 'terminal.resize', cols, rows }); });
  const observer = new ResizeObserver(() => fit.fit()); observer.observe(element('terminal'));
  const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopImmediatePropagation(); send({ type: 'terminal.scroll', direction: event.deltaY < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 30))) }); };
  element('terminal').addEventListener('wheel', wheel, { passive: false, capture: true });
  let touchY: number | undefined;
  const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
  const touchMove = (event: TouchEvent) => {
    if (touchY === undefined || event.touches.length !== 1) return;
    const delta = touchY - event.touches[0].clientY;
    if (Math.abs(delta) < 12) return;
    event.preventDefault(); event.stopImmediatePropagation(); touchY = event.touches[0].clientY;
    send({ type: 'terminal.scroll', direction: delta < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.round(Math.abs(delta) / 14))) });
  };
  element('terminal').addEventListener('touchstart', touchStart, { passive: true, capture: true });
  element('terminal').addEventListener('touchmove', touchMove, { passive: false, capture: true });
  const textarea = element('terminal').querySelector('textarea');
  if (textarea) for (const [key, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })) textarea.setAttribute(key, value);
  ws.onmessage = event => {
    if (epoch !== generation) return;
    try {
      const frame = JSON.parse(event.data);
      if (frame.type === 'terminal.closed') { element('shield').hidden = false; element('shield').textContent = frame.reason; return; }
      if (frame.type !== 'terminal.frame' || frame.encoding !== 'ansi') return;
      // Frames are already authoritative Herdr repaints. Never replay arbitrary PTY tails or reset on full=true.
      const bytes = Uint8Array.from(atob(frame.bytes), c => c.charCodeAt(0));
      applyingFrame = true;
      try { if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height); }
      finally { applyingFrame = false; }
      term.write(bytes, () => { if (epoch === generation) { element('shield').hidden = true; reconnectAttempt = 0; } });
    } catch { ws.close(1002, 'Invalid frame'); }
  };
  ws.onclose = () => {
    if (epoch !== generation) return;
    element('shield').hidden = false;
    if (reconnectAttempt >= 5) { element('shield').textContent = 'Terminal unavailable or already controlled. Retry or use TAKE CONTROL.'; return; }
    element('shield').textContent = 'Connection lost. Reattaching...';
    reconnectTimer = setTimeout(() => { if (epoch === generation && authenticated) void attach(false, true); }, Math.min(1000 * 2 ** reconnectAttempt++, 10000));
  };
  disposeTerminal = () => { observer.disconnect(); input.dispose(); resize.dispose(); element('terminal').removeEventListener('wheel', wheel, true); element('terminal').removeEventListener('touchstart', touchStart, true); element('terminal').removeEventListener('touchmove', touchMove, true); term.dispose(); };
}
async function action(action: string, id?: string, extra: object = {}) {
  const selected = machineId;
  try {
    const result = await api('/api/action', { machine: selected, action, id, ...extra });
    if (machineId !== selected) return;
    const created = result.root_pane || result.pane;
    if (created && action !== 'pane.close') {
      detach(); workspaceId = created.workspace_id; tabId = created.tab_id; paneId = created.pane_id;
    }
    closeRail(); await refresh();
  }
  catch (error) { status(`[ERROR] ${(error as Error).message}`); }
}
element('refresh').onclick = () => { void refresh(); if (paneId) void attach(); };
element('create').onclick = () => void action('workspace.create');
element('new-tab').onclick = () => void action('tab.create', workspaceId);
element('split').onclick = () => void action('pane.split', paneId, { direction: 'right' });
element('takeover').onclick = () => void attach(true);
element('close').onclick = () => { if (confirm('Close this pane and end its running process?')) void action('pane.close', paneId); };
element('logout').onclick = async () => { try { await api('/api/logout', {}); authenticated = false; detach(); login.showModal(); } catch (error) { status(String(error)); } };
login.addEventListener('cancel', e => e.preventDefault());
login.querySelector('form')!.onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/login', { token: element<HTMLInputElement>('token').value }); element<HTMLInputElement>('token').value = ''; login.close(); await refresh(); }
  catch (error) { element('login-error').textContent = (error as Error).message; }
};
// Reuse portable wmux boot text with system fonts. Restricted historical fonts and artwork are not bundled.
const profiles = RETRO_BOOT_PROFILES.filter(p => ['commodore-64', 'apple-iie', 'ibm-pc-at'].includes(p.id));
element('boot-profile').replaceChildren(...profiles.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; return option; }));
let bootGeneration = 0;
async function boot() {
  const profile = profiles.find(p => p.id === element<HTMLSelectElement>('boot-profile').value)!;
  const epoch = ++bootGeneration;
  const target = element('boot'); target.textContent = ''; target.style.color = profile.colors.foreground; target.style.background = profile.colors.background;
  for (const step of profile.boot) {
    if (epoch !== bootGeneration) return;
    if (step.clear) target.textContent = '';
    target.textContent += step.text.replaceAll('WMUX', 'WERDR'); target.scrollTop = target.scrollHeight;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, Math.min(step.delay, 160)));
  }
}
element('boot-profile').onchange = () => void boot();
void boot();
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
setInterval(() => { if (authenticated) void refresh(); }, 5000);
void refresh();
