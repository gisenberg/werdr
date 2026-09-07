import type { Terminal } from 'ghostty-web';
import { loadGhostty } from './terminal-loader';
import { RETRO_BOOT_PROFILES } from './wmux/retro-boot-profiles';
import './boot-fonts.css';

const profiles = RETRO_BOOT_PROFILES.filter(p => ['commodore-64', 'apple-iie', 'ibm-pc-at'].includes(p.id));
type Login = { username: string; password: string } | { token: string };
type Stage = 'boot' | 'username' | 'password' | 'token' | 'submitting' | 'ready';

// Like wmux, boot and authentication write to one fixed-grid Ghostty terminal.
export class BootConsole {
  readonly screen = document.createElement('dialog');
  readonly profile;
  readonly ready: Promise<void>;
  private readonly frame = document.createElement('div');
  private readonly host = document.createElement('div');
  private readonly transcript = document.createElement('div');
  private readonly error = document.createElement('div');
  private readonly switchMode = document.createElement('button');
  private readonly observer: ResizeObserver;
  private terminal?: Terminal;
  private stage: Stage = 'boot';
  private passwordEnabled = false;
  private passwordMode = false;
  private username = '';
  private input = '';
  private previousCR = false;
  private challenge = false;
  private booting = true;
  private skipBoot!: () => void;

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
    this.frame.id = 'boot-frame'; this.host.id = 'boot-terminal';
    this.transcript.id = 'boot-output'; this.transcript.className = 'sr-only';
    this.error.id = 'login-error'; this.error.className = 'sr-only'; this.error.setAttribute('role', 'alert');
    this.switchMode.id = 'login-mode'; this.switchMode.hidden = true;
    this.switchMode.onclick = () => {
      if (this.stage === 'submitting') return;
      this.passwordMode = !this.passwordMode; this.write('\n'); this.prompt();
    };
    this.frame.append(this.host); this.screen.append(this.frame, this.transcript, this.error, this.switchMode);
    document.body.append(this.screen); this.screen.showModal();
    this.screen.addEventListener('cancel', event => { event.preventDefault(); if (this.booting) this.skipBoot(); });
    this.screen.addEventListener('click', event => {
      if (this.booting) this.skipBoot();
      else if (event.target !== this.switchMode) this.terminal?.focus();
    });
    this.screen.addEventListener('keydown', event => { if (this.booting) { event.preventDefault(); this.skipBoot(); } }, true);
    this.observer = new ResizeObserver(() => this.fitViewport()); this.observer.observe(this.screen);
    this.ready = this.animate();
  }

  configure(passwordEnabled: boolean) { this.passwordEnabled = passwordEnabled; this.passwordMode = passwordEnabled; }
  requireAuthentication() {
    const first = !this.challenge || !this.screen.open;
    this.challenge = true;
    if (!this.screen.open) this.screen.showModal();
    if (!this.booting && first) { this.passwordMode = this.passwordEnabled; this.write(this.profile.auth.required); this.prompt(); }
  }
  async complete() {
    if (!this.screen.open) return;
    await this.ready;
    this.setStage('ready'); this.clearSecrets(); this.switchMode.hidden = true;
    await this.write(this.challenge ? this.profile.auth.granted + this.profile.auth.ready : '\n' + this.profile.auth.ready);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, 180));
    this.screen.close(); this.challenge = false;
  }
  private clearSecrets() { this.input = ''; this.username = ''; if (this.terminal?.textarea) this.terminal.textarea.value = ''; }
  private setStage(stage: Stage) {
    this.stage = stage; this.screen.dataset.stage = stage;
    const textarea = this.terminal?.textarea;
    if (textarea) {
      textarea.setAttribute('aria-label', stage === 'username' ? 'Username' : stage === 'password' ? 'Password' : stage === 'token' ? 'Access token' : 'Console');
      textarea.setAttribute('aria-describedby', 'boot-output');
    }
  }
  private prompt() {
    this.clearSecrets(); this.previousCR = false;
    this.setStage(this.passwordMode ? 'username' : 'token');
    this.switchMode.hidden = !this.passwordEnabled;
    this.switchMode.disabled = false;
    this.switchMode.textContent = this.passwordMode ? 'USE ACCESS TOKEN' : 'USE USERNAME AND PASSWORD';
    this.write(this.passwordMode ? this.profile.auth.usernamePrompt : 'ACCESS TOKEN> ');
    this.terminal?.focus(); this.setStage(this.stage);
  }
  private accept(data: string) {
    if (!['username', 'password', 'token'].includes(this.stage) || data.includes('\x1b')) return;
    for (const character of data) {
      if (!['username', 'password', 'token'].includes(this.stage)) return;
      if (character === '\r' || character === '\n') {
        if (character === '\n' && this.previousCR) { this.previousCR = false; continue; }
        this.previousCR = character === '\r';
        this.write('\n');
        if (this.stage === 'username') {
          this.username = this.input; this.input = ''; this.setStage('password'); this.write(this.profile.auth.passwordPrompt);
        } else void this.submit();
      } else {
        this.previousCR = false;
        if (character === '\b' || character === '\x7f') {
          if (this.input.length) { this.input = [...this.input].slice(0, -1).join(''); if (this.stage === 'username') this.write('\b \b'); }
        } else if (character >= ' ' && this.input.length + character.length <= (this.stage === 'username' ? 256 : 4096)) {
          this.input += character;
          if (this.stage === 'username') this.write(character);
        }
      }
    }
  }
  private async submit() {
    const value: Login = this.passwordMode ? { username: this.username, password: this.input } : { token: this.input };
    this.setStage('submitting'); this.clearSecrets(); this.switchMode.disabled = true; this.error.textContent = '';
    await this.write(this.profile.auth.verifying);
    try { await this.login(value); await this.complete(); await this.onAuthenticated(); }
    catch (error) {
      const message = (error as Error).message;
      this.error.textContent = message;
      await this.write(this.profile.auth.failed + message + '\n'); this.prompt();
    }
  }
  private async write(text: string) {
    if (!this.terminal) return;
    await new Promise<void>(resolve => this.terminal!.write(text.replaceAll('WMUX', 'WERDR').replaceAll('\n', '\r\n'), resolve));
    const buffer = this.terminal.buffer.active;
    this.transcript.textContent = Array.from({ length: this.terminal.rows }, (_, row) => buffer.getLine(row)?.translateToString(true) || '').join('\n');
  }
  private fitViewport() {
    // A closed dialog reports zero size. Preserve its geometry for the next auth challenge.
    if (!this.screen.open || !this.screen.clientWidth || !this.screen.clientHeight) return;
    const metrics = this.terminal?.renderer?.getMetrics();
    if (!metrics || !this.terminal) return;
    // Viewport fitting never changes terminal cells or depends on authentication state.
    const width = Math.min(this.screen.clientWidth * .92, this.screen.clientHeight * .92 * 4 / 3);
    const naturalWidth = metrics.width * this.terminal.cols, naturalHeight = metrics.height * this.terminal.rows;
    this.frame.style.width = `${width}px`; this.frame.style.height = `${width * .75}px`;
    this.host.style.width = `${naturalWidth}px`; this.host.style.height = `${naturalHeight}px`;
    this.host.style.transform = `scale(${width / naturalWidth}, ${width * .75 / naturalHeight})`;
  }
  private async animate() {
    const dismissed = new Promise<void>(resolve => { this.skipBoot = resolve; });
    const [library] = await Promise.all([
      loadGhostty(),
      Promise.race([document.fonts.load(`400 16px ${this.profile.fontFamily}`).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]),
    ]);
    const terminal = new library.Terminal({ cols: this.profile.columns, rows: this.profile.rows,
      fontSize: this.profile.fontSize.desktop, fontFamily: this.profile.fontFamily, scrollback: 0,
      cursorBlink: true, cursorStyle: 'block', theme: { background: this.profile.colors.background, foreground: this.profile.colors.foreground,
        cursor: this.profile.colors.foreground, cursorAccent: this.profile.colors.background } });
    this.terminal = terminal; terminal.open(this.host); this.setStage('boot');
    if (terminal.textarea) for (const [key, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'enter', 'aria-autocomplete': 'none', 'data-form-type': 'other', 'data-lpignore': 'true', 'data-gramm': 'false', 'data-ms-editor': 'false' })) terminal.textarea.setAttribute(key, value);
    terminal.onData(data => this.accept(data)); this.fitViewport();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let skipped = false; void dismissed.then(() => { skipped = true; });
    for (const step of this.profile.boot) {
      if (skipped) break;
      if (step.clear) await this.write('\x1b[2J\x1b[H');
      if (step.position) await this.write(`\x1b[${step.position.row};${step.position.column}H`);
      if (step.overwrite) await this.write('\r\x1b[2K');
      if (step.inverse) await this.write('\x1b[7m');
      await this.write(step.text);
      if (step.inverse) await this.write('\x1b[27m');
      if (!reduced) await Promise.race([new Promise(resolve => setTimeout(resolve, Math.min(step.delay, 160))), dismissed]);
    }
    this.booting = false;
    if (this.challenge) { await this.write(this.profile.auth.required); this.prompt(); }
  }
}
