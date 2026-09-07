import { RETRO_BOOT_PROFILES } from './wmux/retro-boot-profiles';
import './boot-fonts.css';

const profiles = RETRO_BOOT_PROFILES.filter(p => ['commodore-64', 'apple-iie', 'ibm-pc-at'].includes(p.id));
type Login = { username: string; password: string } | { token: string };

export class BootConsole {
  readonly screen = document.createElement('dialog');
  readonly profile;
  readonly ready: Promise<void>;
  private readonly frame = document.createElement('div');
  private readonly output = document.createElement('pre');
  private readonly form = document.createElement('form');
  private readonly query = <T extends HTMLElement = HTMLElement>(id: string) => this.form.querySelector<T>(`#${id}`)!;
  private readonly observer: ResizeObserver;
  private booting = true;
  private skipBoot!: () => void;
  private passwordEnabled = false;
  private passwordMode = false;
  private stage: 'username' | 'password' | 'token' | 'submitting' = 'token';
  private challenge = false;
  private disposed = false;

  constructor(private readonly login: (value: Login) => Promise<void>, private readonly onAuthenticated: () => Promise<void>) {
    let previous: string | null = null;
    try { previous = localStorage.getItem('werdr-last-boot'); } catch {}
    const candidates = profiles.filter(p => p.id !== previous);
    this.profile = candidates[Math.floor(Math.random() * candidates.length)];
    try { localStorage.setItem('werdr-last-boot', this.profile.id); } catch {}
    const privateFont = this.profile.id === 'apple-iie' ? ['Retro Apple II', 'Apple_2.woff2'] : this.profile.id === 'ibm-pc-at' ? ['Retro IBM CGA', 'IBM_CGA.woff2'] : undefined;
    if (privateFont) document.fonts.add(new FontFace(privateFont[0], `url(/fonts/retro/${privateFont[1]})`, { weight: '400' }));
    this.screen.id = 'boot'; this.screen.setAttribute('aria-label', 'werdr console');
    this.screen.style.setProperty('--boot-border', this.profile.colors.border);
    this.screen.style.setProperty('--boot-background', this.profile.colors.background);
    this.screen.style.setProperty('--boot-foreground', this.profile.colors.foreground);
    this.screen.style.fontFamily = this.profile.fontFamily;
    this.frame.id = 'boot-frame'; this.output.id = 'boot-output'; this.output.setAttribute('aria-hidden', 'true');
    this.form.id = 'login'; this.form.hidden = true;
    this.form.innerHTML = `<div id="login-status" role="status"></div>
<div id="credentials" hidden><label id="username-field"><span id="username-prompt"></span><input id="username" aria-label="Username" autocomplete="username" maxlength="256" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>
<label id="password-field" hidden><span id="password-prompt"></span><input id="password" aria-label="Password" type="password" autocomplete="current-password" maxlength="4096" enterkeyhint="go"></label></div>
<label id="token-field"><span>ACCESS TOKEN&gt; </span><input id="token" aria-label="Access token" type="password" autocomplete="off" maxlength="4096" enterkeyhint="go"></label>
<div id="login-error" role="alert"></div><div class="console-actions"><button type="submit" id="login-submit">[ENTER]</button><button id="login-mode" type="button" hidden>USE ACCESS TOKEN</button></div>`;
    this.query('username-prompt').textContent = this.profile.auth.usernamePrompt;
    this.query('password-prompt').textContent = this.profile.auth.passwordPrompt;
    this.frame.append(this.output, this.form); this.screen.append(this.frame); document.body.append(this.screen);
    this.screen.showModal();
    this.screen.addEventListener('cancel', event => { event.preventDefault(); if (this.booting) this.skipBoot(); });
    this.screen.addEventListener('click', () => { if (this.booting) this.skipBoot(); });
    this.screen.addEventListener('keydown', event => {
      if (this.booting) { event.preventDefault(); this.skipBoot(); }
    });
    this.query('login-mode').onclick = () => this.setMode(!this.passwordMode);
    this.form.onsubmit = event => { event.preventDefault(); void this.submit(); };
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.screen);
    visualViewport?.addEventListener('resize', this.viewportChanged);
    this.ready = this.animate();
  }

  configure(passwordEnabled: boolean) {
    this.passwordEnabled = passwordEnabled;
    this.query('login-mode').hidden = !passwordEnabled;
    this.setMode(passwordEnabled);
  }

  requireAuthentication() {
    this.challenge = true;
    if (!this.screen.open) { this.screen.showModal(); this.setMode(this.passwordEnabled); }
    if (!this.booting) this.showPrompt();
  }

  async complete() {
    if (!this.screen.open) return;
    await this.ready;
    this.form.hidden = true;
    this.write(this.challenge ? this.profile.auth.granted + this.profile.auth.ready : '\n' + this.profile.auth.ready);
    this.resize();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, 180));
    this.screen.close(); this.clearSecrets(); this.challenge = false;
  }

  dispose() {
    this.disposed = true; this.skipBoot(); this.clearSecrets();
    this.observer.disconnect(); visualViewport?.removeEventListener('resize', this.viewportChanged); this.screen.remove();
  }

  private readonly viewportChanged = () => { this.resize(); this.focusPrompt(); };
  private clearSecrets() {
    this.query<HTMLInputElement>('password').value = ''; this.query<HTMLInputElement>('token').value = '';
  }
  private setMode(password: boolean) {
    this.passwordMode = password; this.stage = password ? 'username' : 'token'; this.clearSecrets();
    this.query<HTMLInputElement>('username').value = ''; this.query<HTMLInputElement>('username').readOnly = false;
    this.query('credentials').hidden = !password; this.query('password-field').hidden = true;
    this.query('token-field').hidden = password;
    this.query<HTMLInputElement>('username').required = password;
    this.query<HTMLInputElement>('password').required = false;
    this.query<HTMLInputElement>('token').required = !password;
    this.query('login-mode').textContent = password ? 'USE ACCESS TOKEN' : 'USE USERNAME AND PASSWORD';
    this.query('login-error').textContent = '';
    this.query('login-status').textContent = this.profile.auth.required.trim();
    this.focusPrompt();
  }
  private showPrompt() {
    this.form.hidden = false; this.screen.classList.add('authenticating'); this.resize(); this.focusPrompt();
  }
  private focusPrompt() {
    if (this.form.hidden || !this.screen.open || this.stage === 'submitting') return;
    this.query<HTMLInputElement>(this.stage).focus({ preventScroll: true });
    this.frame.scrollTop = this.frame.scrollHeight;
  }
  private async submit() {
    if (this.stage === 'submitting') return;
    if (this.stage === 'username') {
      this.stage = 'password'; this.query<HTMLInputElement>('username').readOnly = true;
      this.query('password-field').hidden = false; this.query<HTMLInputElement>('password').required = true;
      this.focusPrompt(); return;
    }
    const value: Login = this.passwordMode
      ? { username: this.query<HTMLInputElement>('username').value, password: this.query<HTMLInputElement>('password').value }
      : { token: this.query<HTMLInputElement>('token').value };
    this.stage = 'submitting'; this.clearSecrets();
    this.query<HTMLButtonElement>('login-submit').disabled = true; this.query<HTMLButtonElement>('login-mode').disabled = true;
    this.query('login-error').textContent = ''; this.query('login-status').textContent = this.profile.auth.verifying.trim();
    try {
      await this.login(value);
      if (this.disposed) return;
      await this.complete(); await this.onAuthenticated();
    } catch (error) {
      if (this.disposed) return;
      this.setMode(this.passwordMode);
      this.query('login-error').textContent = this.profile.auth.failed.trim() + '\n' + (error as Error).message;
      this.focusPrompt();
    } finally {
      this.query<HTMLButtonElement>('login-submit').disabled = false; this.query<HTMLButtonElement>('login-mode').disabled = false;
    }
  }
  private write(text: string, overwrite = false) {
    if (overwrite) this.output.textContent = this.output.textContent!.slice(0, this.output.textContent!.lastIndexOf('\n') + 1);
    this.output.textContent += text.replaceAll('WMUX', 'WERDR');
    this.output.textContent = this.output.textContent.split('\n').slice(-this.profile.rows).join('\n');
    this.frame.scrollTop = this.frame.scrollHeight;
  }
  private resize() {
    const width = Math.min(this.screen.clientWidth * .92, this.screen.clientHeight * .92 * 4 / 3);
    if (this.screen.classList.contains('authenticating')) {
      // Keep editable prompts readable when a phone keyboard consumes the viewport.
      this.frame.style.width = `${Math.min(1104, this.screen.clientWidth * .92)}px`;
      this.frame.style.height = `${this.screen.clientHeight * .92}px`;
      this.frame.style.fontSize = `${this.screen.clientWidth <= 700 ? 16 : 20}px`;
      this.frame.style.transform = 'none';
      this.frame.scrollTop = this.frame.scrollHeight;
    } else {
      const fontSize = width * 3 / 4 / (this.profile.rows * 1.25);
      this.frame.style.width = `${this.profile.columns}ch`; this.frame.style.height = `${this.profile.rows * 1.25}em`;
      this.frame.style.fontSize = `${fontSize}px`; this.frame.style.transform = 'none';
      const naturalWidth = this.frame.getBoundingClientRect().width;
      this.frame.style.transform = `scaleX(${naturalWidth ? width / naturalWidth : 1})`;
    }
  }
  private async animate() {
    const dismissed = new Promise<void>(resolve => { this.skipBoot = resolve; });
    // Bounded font loading prevents a missing optional private font from blocking sign-in.
    await Promise.race([document.fonts.load(`400 16px ${this.profile.fontFamily}`).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    this.resize();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let skipped = false;
    void dismissed.then(() => { skipped = true; });
    const run = async () => {
      for (const step of this.profile.boot) {
        if (this.disposed || skipped) return;
        if (step.clear) this.output.textContent = '';
        this.write(step.text, step.overwrite);
        if (!reduced) await new Promise(resolve => setTimeout(resolve, Math.min(step.delay, 160)));
      }
      if (!reduced) await new Promise(resolve => setTimeout(resolve, 300));
    };
    await Promise.race([run(), dismissed]);
    this.booting = false;
    if (this.challenge) this.showPrompt();
  }
}
