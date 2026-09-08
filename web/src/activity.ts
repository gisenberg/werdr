import type { FleetState, Notice } from '../shared/fleet';
import type { Preferences } from '../shared/settings';
import type { Api } from './host-manager';
import { NotificationPolicy, notificationTarget } from './notification-policy';
import doneSound from '../../assets/sounds/done.mp3?url';
import requestSound from '../../assets/sounds/request.mp3?url';
const noticeLabel = (notice: Notice) => ({ attention: 'ATTENTION', finished: 'DONE', update: 'UPDATE', custom: 'NOTICE' })[notice.kind];
export const activityMarkup = `<dialog id="activity-dialog"><h1>FLEET ACTIVITY</h1><p>Agent attention and completion events from every connected host.</p><div class="inline-actions"><button id="read-notices">MARK ALL READ</button><button id="desktop-notices">ALLOW DESKTOP NOTIFICATIONS</button></div><p id="activity-error" role="alert"></p><div id="notice-list"></div><button id="activity-done">DONE</button></dialog><button id="notice-toast" aria-live="polite" hidden></button>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class Activity {
  private state: FleetState = { generation: '', revision: 0, hosts: [], notices: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private policy = new NotificationPolicy();
  private audio = new Set<HTMLAudioElement>();
  private desktop = new Set<Notification>();
  constructor(private readonly api: Api, private readonly select: (machine: string, workspace: string, tab: string, pane: string) => void, private readonly current: () => { machine: string; workspace: string; tab: string }, private readonly preferences: () => Preferences, private readonly report: (message: string) => void, private readonly focus: () => void) {
    element('activity-done').onclick = () => element<HTMLDialogElement>('activity-dialog').close();
    element('read-notices').onclick = () => { void api('/api/notices/read', {}).catch(error => { element('activity-error').textContent = error.message; }); };
    element('desktop-notices').onclick = async () => {
      if (!('Notification' in window)) { element('activity-error').textContent = 'Desktop notifications are unavailable in this browser.'; return; }
      const permission = await Notification.requestPermission();
      try { localStorage.setItem('werdr-desktop-notices', permission === 'granted' ? 'on' : 'off'); } catch {}
      element('activity-error').textContent = permission === 'granted' ? ['desktop', 'both'].includes(this.preferences().toastDelivery) ? 'Desktop notifications are allowed while werdr is open.' : 'Permission granted. Choose desktop or both under Settings > Alert delivery to receive notifications.' : 'Notifications were not enabled. Check browser permissions to change this.';
    };
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) return;
    clearTimeout(this.timer); this.policy.reset(); element('notice-toast').hidden = true;
    for (const audio of this.audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } this.audio.clear();
    for (const notification of this.desktop) notification.close(); this.desktop.clear();
  }
  open() { if (!this.active) return; this.render(); element<HTMLDialogElement>('activity-dialog').showModal(); }
  update(state: FleetState, added?: Notice) {
    if (!this.active) return;
    if (this.state.generation && this.state.generation !== state.generation) this.policy.reset();
    this.state = state;
    const unread = state.notices.filter(notice => !notice.read).length;
    element('activity').textContent = `ACTIVITY${unread ? ' [' + unread + ']' : ''}`;
    element('activity').setAttribute('aria-label', `Fleet activity${unread ? ', ' + unread + ' unread' : ''}`);
    if (element<HTMLDialogElement>('activity-dialog').open) this.render();
    if (added) this.policy.receive(added, performance.now(), this.preferences());
    this.tick();
  }
  refreshPreferences() { if (this.active) this.tick(); }
  openVisible() {
    if (!this.active) return;
    this.tick();
    const notice = this.policy.visible?.notice;
    if (notice) this.follow(notice, true);
  }
  private tick() {
    if (!this.active) return;
    clearTimeout(this.timer);
    const preferences = this.preferences();
    const effects = this.policy.tick(performance.now(), this.state, { ...this.current(), focused: !document.hidden && document.hasFocus() }, preferences);
    for (const effect of effects) {
      if (effect.kind === 'sound') this.sound(effect.notice);
      else this.notifyDesktop(effect.notice);
    }
    const toast = element('notice-toast'), visible = this.policy.visible?.notice;
    toast.hidden = !visible;
    if (visible) {
      toast.dataset.notice = visible.id; toast.dataset.position = visible.position ?? preferences.toastPosition;
      const text = `[${noticeLabel(visible)}] ${visible.machineLabel}: ${visible.title}${visible.body ? '\n' + visible.body : ''}`;
      const binding = preferences.shortcuts.bindings.open_notification_target.join(' / ');
      toast.textContent = `${text}\n${binding ? '[' + binding + '] ' : ''}${visible.paneId ? 'OPEN PANE' : 'DISMISS'}`;
      // Resolve the currently painted ID, so an old click cannot consume its successor.
      toast.onclick = () => { if (this.policy.visible?.notice.id === visible.id) { this.tick(); if (this.policy.visible?.notice.id === visible.id) this.follow(visible, true); } };
    } else { delete toast.dataset.notice; toast.onclick = null; }
    const deadline = this.policy.nextDeadline;
    if (deadline !== undefined) this.timer = setTimeout(() => this.tick(), Math.max(0, deadline - performance.now()));
  }
  private sound(notice: Notice) {
    const audio = new Audio(notice.sound === 'request' ? requestSound : doneSound); this.audio.add(audio);
    const close = () => { this.audio.delete(audio); audio.pause(); audio.removeAttribute('src'); audio.load(); };
    audio.onended = close; audio.onerror = close;
    void audio.play().catch(close);
  }
  private notifyDesktop(notice: Notice) {
    try {
      if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem('werdr-desktop-notices') === 'on') {
        const notification = new Notification(notice.title, { body: notice.body, tag: notice.id });
        this.desktop.add(notification); notification.onclose = () => this.desktop.delete(notification);
        notification.onclick = () => { if (this.active && this.desktop.has(notification)) { window.focus(); this.follow(notice, false); } notification.close(); };
      }
    } catch {}
  }
  private follow(notice: Notice, visible = false) {
    if (!this.active) return;
    const target = notificationTarget(this.state, notice);
    if (target.kind === 'offline') { this.report(`[UNAVAILABLE] ${notice.machineLabel} is unavailable.`); this.focus(); return; }
    if (visible && !this.policy.consume(notice.id, performance.now(), this.preferences())) return;
    void this.api('/api/notices/read', { id: notice.id }).catch(() => {});
    if (target.kind === 'pane') {
      element<HTMLDialogElement>('activity-dialog').close();
      this.select(notice.machineId, target.pane.workspace_id, target.pane.tab_id, target.pane.pane_id);
    } else {
      if (target.kind === 'stale') this.report(`[UNAVAILABLE] ${notice.machineLabel}: this notification's original target is no longer available.`);
      this.focus();
    }
    this.tick();
  }
  private render() {
    const parent = element('notice-list'); parent.replaceChildren();
    if (!this.state.notices.length) { const empty = document.createElement('p'); empty.textContent = 'No agent notifications yet.'; parent.append(empty); }
    for (const notice of this.state.notices) {
      const row = document.createElement('section'); row.className = 'notice-row'; row.dataset.read = String(notice.read);
      const title = document.createElement('strong'); title.textContent = `[${noticeLabel(notice)}] ${notice.title}`;
      const body = document.createElement('p'); body.textContent = `${notice.body} / ${new Date(notice.created).toLocaleString()}`;
      const controls = document.createElement('div'); controls.className = 'inline-actions';
      const open = document.createElement('button'); open.textContent = 'OPEN PANE';
      open.disabled = notificationTarget(this.state, notice).kind !== 'pane';
      if (!notice.paneId) open.textContent = 'NO PANE TARGET'; open.onclick = () => this.follow(notice);
      const read = document.createElement('button'); read.textContent = notice.read ? '[READ]' : 'MARK READ'; read.disabled = notice.read;
      read.onclick = () => { void this.api('/api/notices/read', { id: notice.id }).catch(error => { element('activity-error').textContent = error.message; }); };
      controls.append(open, read); row.append(title, body, controls); parent.append(row);
    }
  }
}
