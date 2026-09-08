export class DetachedScreen {
  readonly element = document.createElement('dialog');
  private resume = document.createElement('button');
  private message = document.createElement('p');
  constructor(onResume: () => void, onLogout: () => void) {
    this.element.id = 'detached-dialog'; this.element.setAttribute('aria-labelledby', 'detached-title');
    const heading = document.createElement('h1'); heading.id = 'detached-title'; heading.textContent = '[DETACHED]';
    const detail = document.createElement('p'); detail.textContent = 'This browser is detached. Your sessions keep running.';
    this.resume.id = 'resume-client'; this.resume.textContent = '[R] RESUME'; this.resume.onclick = onResume;
    const logout = document.createElement('button'); logout.id = 'detached-logout'; logout.textContent = 'SIGN OUT'; logout.onclick = onLogout;
    this.message.id = 'detached-status'; this.message.setAttribute('role', 'status');
    this.element.append(heading, detail, this.message, this.resume, logout);
    this.element.addEventListener('cancel', event => event.preventDefault());
    this.element.addEventListener('keydown', event => {
      if (!this.resume.disabled && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'r') { event.preventDefault(); onResume(); }
    });
    document.body.append(this.element);
  }
  show() { this.busy(false); if (!this.element.open) this.element.showModal(); this.resume.focus(); }
  busy(value: boolean) { this.resume.disabled = value; this.message.textContent = value ? '[WAIT] Reconnecting...' : ''; }
  error(message: string) { this.busy(false); this.message.textContent = `[OFFLINE] ${message}`; this.resume.focus(); }
  close() { this.element.close(); }
}
