import type { FleetState, Notice } from '../shared/fleet';
import type { Preferences } from '../shared/settings';
import type { Api } from './host-manager';
export const activityMarkup = `<dialog id="activity-dialog"><h1>FLEET ACTIVITY</h1><p>Agent attention and completion events from every connected host.</p><div class="inline-actions"><button id="read-notices">MARK ALL READ</button><button id="desktop-notices">ENABLE DESKTOP NOTIFICATIONS</button></div><p id="activity-error" role="alert"></p><div id="notice-list"></div><button id="activity-done">DONE</button></dialog><button id="notice-toast" hidden></button>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class Activity {
  private state: FleetState = { generation: '', revision: 0, hosts: [], notices: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private desktop = new Set<Notification>();
  constructor(private readonly api: Api, private readonly select: (machine: string, workspace: string, tab: string, pane: string) => void, private readonly current: () => { machine: string; pane: string }, private readonly preferences: () => Preferences) {
    element('activity-done').onclick = () => element<HTMLDialogElement>('activity-dialog').close();
    element('read-notices').onclick = () => { void api('/api/notices/read', {}).catch(error => { element('activity-error').textContent = error.message; }); };
    element('desktop-notices').onclick = async () => {
      if (!('Notification' in window)) { element('activity-error').textContent = 'Desktop notifications are unavailable in this browser.'; return; }
      const permission = await Notification.requestPermission();
      try { localStorage.setItem('werdr-desktop-notices', permission === 'granted' ? 'on' : 'off'); } catch {}
      element('activity-error').textContent = permission === 'granted' ? 'Desktop notifications enabled while werdr is open.' : 'Notifications were not enabled. Check browser permissions to change this.';
    };
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) return;
    clearTimeout(this.timer); element('notice-toast').hidden = true;
    for (const notification of this.desktop) notification.close(); this.desktop.clear();
  }
  open() { if (!this.active) return; this.render(); element<HTMLDialogElement>('activity-dialog').showModal(); }
  update(state: FleetState, added?: Notice) {
    if (!this.active) return;
    this.state = state;
    const unread = state.notices.filter(notice => !notice.read).length;
    element('activity').textContent = `ACTIVITY${unread ? ' [' + unread + ']' : ''}`;
    element('activity').setAttribute('aria-label', `Fleet activity${unread ? ', ' + unread + ' unread' : ''}`);
    if (element<HTMLDialogElement>('activity-dialog').open) this.render();
    if (!added) return;
    const preferences = this.preferences();
    if (added.kind === 'attention' ? !preferences.notificationAttention : !preferences.notificationFinished) return;
    const current = this.current();
    if (!document.hidden && document.hasFocus() && current.machine === added.machineId && current.pane === added.paneId) { void this.api('/api/notices/read', { id: added.id }).catch(() => {}); return; }
    const toast = element('notice-toast'); toast.textContent = `[${added.kind === 'attention' ? 'ATTENTION' : 'DONE'}] ${added.machineLabel}: ${added.title}`; toast.hidden = preferences.toastSeconds === 0;
    toast.onclick = () => { this.follow(added); toast.hidden = true; };
    clearTimeout(this.timer); this.timer = setTimeout(() => { toast.hidden = true; }, preferences.toastSeconds * 1000);
    if (preferences.notificationSound) {
      try { const audio = new AudioContext(); const tone = audio.createOscillator(), gain = audio.createGain(); tone.frequency.value = added.kind === 'attention' ? 660 : 440; gain.gain.value = .04; tone.connect(gain); gain.connect(audio.destination); tone.start(); tone.stop(audio.currentTime + .12); tone.onended = () => void audio.close().catch(() => {}); setTimeout(() => { if (audio.state !== 'closed') void audio.close().catch(() => {}); }, 1000); } catch {}
    }
    try {
      if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem('werdr-desktop-notices') === 'on') {
        const notification = new Notification(added.title, { body: added.body, tag: added.id });
        this.desktop.add(notification); notification.onclose = () => this.desktop.delete(notification);
        notification.onclick = () => { window.focus(); this.follow(added); notification.close(); };
      }
    } catch {}
  }
  private follow(notice: Notice) {
    if (!this.active) return;
    void this.api('/api/notices/read', { id: notice.id }).catch(() => {});
    const host = this.state.hosts.find(host => host.machine.id === notice.machineId);
    if (host?.snapshot?.panes.some(pane => pane.pane_id === notice.paneId)) {
      element<HTMLDialogElement>('activity-dialog').close(); this.select(notice.machineId, notice.workspaceId, notice.tabId, notice.paneId);
    } else this.open();
  }
  private render() {
    const parent = element('notice-list'); parent.replaceChildren();
    if (!this.state.notices.length) { const empty = document.createElement('p'); empty.textContent = 'No agent notifications yet.'; parent.append(empty); }
    for (const notice of this.state.notices) {
      const row = document.createElement('section'); row.className = 'notice-row'; row.dataset.read = String(notice.read);
      const title = document.createElement('strong'); title.textContent = `[${notice.kind === 'attention' ? 'ATTENTION' : 'DONE'}] ${notice.title}`;
      const body = document.createElement('p'); body.textContent = `${notice.body} / ${new Date(notice.created).toLocaleString()}`;
      const controls = document.createElement('div'); controls.className = 'inline-actions';
      const open = document.createElement('button'); open.textContent = 'OPEN PANE';
      open.disabled = !this.state.hosts.some(host => host.machine.id === notice.machineId && host.snapshot?.panes.some(pane => pane.pane_id === notice.paneId)); open.onclick = () => this.follow(notice);
      const read = document.createElement('button'); read.textContent = notice.read ? '[READ]' : 'MARK READ'; read.disabled = notice.read;
      read.onclick = () => { void this.api('/api/notices/read', { id: notice.id }).catch(error => { element('activity-error').textContent = error.message; }); };
      controls.append(open, read); row.append(title, body, controls); parent.append(row);
    }
  }
}
