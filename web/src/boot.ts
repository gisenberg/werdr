import type { Terminal } from 'ghostty-web';
import { loadGhostty } from './terminal-loader';
import { BootPresentation, type VisualPhase } from './boot-presentation';
import { playRetroPostSound, playRetroFloppySound } from './wmux/retro-boot-audio';
import { RETRO_BOOT_PROFILES } from './wmux/retro-boot-profiles';
import './boot-fonts.css';
import './boot-fonts';

const profiles = RETRO_BOOT_PROFILES;
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
  private readonly presentation: BootPresentation;
  private graphicalInput?: HTMLTextAreaElement;
  private visualPhase: VisualPhase = 'terminal';
  private stopSound = () => {};
  private acknowledgeGuru = () => {};
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
    this.presentation = new BootPresentation(this.profile, () => this.acknowledgeGuru(), () => this.accept('\r'));
    this.screen.className = `retro-boot-screen retro-boot-${this.profile.id}${this.profile.graphicalShell ? ` retro-graphical-${this.profile.graphicalShell}` : ''}`;
    this.screen.dataset.bootProfile = this.profile.id;
    for (const [name, value] of Object.entries(this.profile.colors)) this.screen.style.setProperty(`--retro-${name}`, value);
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
    this.frame.append(this.host, this.presentation.element);
    if (this.profile.graphicalShell) {
      const input = document.createElement('textarea'); input.className = 'retro-graphical-input'; input.style.fontSize = '16px';
      input.addEventListener('input', () => { const value = input.value; input.value = ''; this.accept(value); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === 'Backspace') { event.preventDefault(); this.accept(event.key === 'Enter' ? '\r' : '\x7f'); } });
      this.graphicalInput = input; this.frame.append(input);
    }
    this.screen.append(this.frame, this.transcript, this.error, this.switchMode);
    document.body.append(this.screen); this.screen.showModal();
    this.screen.addEventListener('cancel', event => { event.preventDefault(); if (this.booting) { if (this.visualPhase === 'guru') this.acknowledgeGuru(); else this.skipBoot(); } });
    this.screen.addEventListener('click', event => {
      if (this.booting) { if (this.visualPhase === 'guru') this.acknowledgeGuru(); else this.skipBoot(); }
      else if (event.target !== this.switchMode) this.focus();
    });
    this.screen.addEventListener('keydown', event => { if (this.booting) { event.preventDefault(); if (this.visualPhase === 'guru') this.acknowledgeGuru(); else this.skipBoot(); } }, true);
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
    this.setStage('ready'); this.clearSecrets(); this.stopSound(); this.switchMode.hidden = true;
    await this.write(this.challenge ? this.profile.auth.granted + this.profile.auth.ready : '\n' + this.profile.auth.ready);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, 180));
    this.screen.close(); this.challenge = false;
  }
  private clearSecrets() { this.input = ''; this.username = ''; if (this.terminal?.textarea) this.terminal.textarea.value = ''; if (this.graphicalInput) this.graphicalInput.value = ''; this.render(); }
  private setStage(stage: Stage) {
    this.stage = stage; this.screen.dataset.stage = stage;
    const textarea = this.graphicalInput || this.terminal?.textarea;
    if (textarea) {
      textarea.setAttribute('aria-label', stage === 'username' ? 'Username' : stage === 'password' ? 'Password' : stage === 'token' ? 'Access token' : 'Console');
      textarea.setAttribute('aria-describedby', 'boot-output');
    }
    this.render();
  }
  private prompt() {
    this.clearSecrets(); this.previousCR = false;
    this.setStage(this.passwordMode ? 'username' : 'token');
    this.switchMode.hidden = !this.passwordEnabled;
    this.switchMode.disabled = false;
    this.switchMode.textContent = this.passwordMode ? 'USE ACCESS TOKEN' : 'USE USERNAME AND PASSWORD';
    this.write(this.passwordMode ? this.profile.auth.usernamePrompt : 'ACCESS TOKEN> ');
    this.focus(); this.setStage(this.stage);
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
    this.render();
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
    if (!text) return;
    if (!this.terminal) { this.transcript.textContent += text.replaceAll('WMUX', 'WERDR').replaceAll('wmux', 'werdr'); this.render(); return; }
    await new Promise<void>(resolve => this.terminal!.write(text.replaceAll('WMUX', 'WERDR').replaceAll('wmux', 'werdr').replaceAll('\n', '\r\n'), resolve));
    const buffer = this.terminal.buffer.active;
    this.transcript.textContent = Array.from({ length: this.terminal.rows }, (_, row) => buffer.getLine(row)?.translateToString(true) || '').join('\n');
  }
  private focus() { if (this.graphicalInput) this.graphicalInput.focus(); else this.terminal?.focus(); }
  private render() {
    this.presentation.render(this.visualPhase, this.stage, this.stage === 'username' ? this.input : this.username,
      this.stage === 'password' || this.stage === 'token' ? this.input.length : 0,
      this.stage === 'submitting' ? 'Checking credentials...' : this.stage === 'ready' ? 'WERDR READY' : this.error.textContent || '');
    this.screen.dataset.bootPhase = this.visualPhase;
    this.host.inert = this.visualPhase !== 'terminal';
    this.host.style.visibility = this.visualPhase === 'terminal' ? 'visible' : 'hidden';
  }
  private fitViewport() {
    if (!this.screen.open || !this.screen.clientWidth || !this.screen.clientHeight) return;
    const [nativeWidth, nativeHeight] = this.presentation.framebuffer;
    const ratio = nativeWidth / nativeHeight;
    const width = Math.min(920, this.screen.clientWidth * .92, this.screen.clientHeight * .92 * ratio), height = width / ratio;
    this.frame.style.width = `${width}px`; this.frame.style.height = `${height}px`;
    const visualWidth = this.profile.id.startsWith('amiga-') ? 920 : Math.min(920, Math.max(640, nativeWidth));
    const visualHeight = visualWidth / ratio;
    this.presentation.element.style.width = `${visualWidth}px`; this.presentation.element.style.height = `${visualHeight}px`;
    this.presentation.element.style.transform = `scale(${width / visualWidth})`;
    const metrics = this.terminal?.renderer?.getMetrics();
    if (!metrics || !this.terminal) return;
    const titleHeight = this.profile.id.startsWith('amiga-') ? 22 * width / visualWidth : 0;
    const naturalWidth = metrics.width * this.terminal.cols, naturalHeight = metrics.height * this.terminal.rows;
    this.host.style.width = `${naturalWidth}px`; this.host.style.height = `${naturalHeight}px`; this.host.style.top = `${titleHeight}px`;
    this.host.style.transform = `scale(${width / naturalWidth}, ${(height - titleHeight) / naturalHeight})`;
  }
  private async animate() {
    const dismissed = new Promise<void>(resolve => { this.skipBoot = resolve; });
    const [library] = await Promise.all([
      this.profile.graphicalShell ? Promise.resolve(undefined) : loadGhostty(),
      Promise.race([Promise.all([this.profile.fontFamily, '"Retro IBM 2915"', ...(this.profile.graphicalShell === 'nextstep' ? ['"Retro Lisa Console"'] : [])].map(family => document.fonts.load(`400 16px ${family}`))).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]),
    ]);
    const terminal = library ? new library.Terminal({ cols: this.profile.columns, rows: this.profile.rows,
      fontSize: this.profile.fontSize.desktop, fontFamily: this.profile.fontFamily, scrollback: 0,
      cursorBlink: true, cursorStyle: 'block', theme: { background: this.profile.colors.background, foreground: this.profile.colors.foreground,
        cursor: this.profile.colors.foreground, cursorAccent: this.profile.colors.background } }) : undefined;
    this.terminal = terminal; terminal?.open(this.host); this.setStage('boot');
    const textarea = this.graphicalInput || terminal?.textarea;
    if (textarea) for (const [key, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'enter', 'aria-autocomplete': 'none', 'data-form-type': 'other', 'data-lpignore': 'true', 'data-gramm': 'false', 'data-ms-editor': 'false' })) textarea.setAttribute(key, value);
    terminal?.onData(data => this.accept(data)); this.fitViewport();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let skipped = false; void dismissed.then(() => { skipped = true; });
    const pause = async (ms: number) => { if (!reduced && !skipped) await Promise.race([new Promise(resolve => setTimeout(resolve, ms)), dismissed]); };
    const visual = (phase: VisualPhase) => { this.visualPhase = phase; this.render(); };
    const isAmiga = this.profile.id.startsWith('amiga-');
    if (!isAmiga && !this.profile.boot.some(step => step.postSound)) this.stopSound = playRetroPostSound(this.profile.id);
    if (this.profile.graphicalShell) {
      visual('artwork'); await pause(1100);
    } else if (this.profile.showBootArtwork !== false) {
      if (this.profile.specialBoot === 'amiga-guru') {
        visual('guru');
        await Promise.race([pause(2000), new Promise<void>(resolve => { this.acknowledgeGuru = resolve; })]);
      }
      if (isAmiga) {
        this.screen.style.setProperty('--boot-border', '#ffffff'); visual('blank');
        this.stopSound = this.profile.specialBoot ? playRetroFloppySound() : playRetroPostSound(this.profile.id);
        await pause(600);
      }
      visual('artwork'); await pause(isAmiga ? 1600 : 700);
    }
    visual('terminal');
    for (const [index, step] of (this.profile.graphicalShell ? [] : this.profile.boot).entries()) {
      if (skipped) break;
      this.screen.dataset.bootStep = String(index);
      this.screen.classList.toggle('retro-tape-border-header', step.tapeBorder === 'header');
      this.screen.classList.toggle('retro-tape-border-data', step.tapeBorder === 'data');
      this.screen.dataset.tapeBorder = step.tapeBorder || '';
      if (step.clear) await this.write('\x1b[2J\x1b[H');
      if (step.position) await this.write(`\x1b[${step.position.row};${step.position.column}H`);
      if (step.overwrite) await this.write('\r\x1b[2K');
      if (step.inverse) await this.write('\x1b[7m');
      if (step.postSound) { this.stopSound(); this.stopSound = playRetroPostSound(this.profile.id); }
      if (step.typedFrom === undefined || reduced) await this.write(step.text);
      else {
        await this.write(step.text.slice(0, step.typedFrom));
        for (const character of step.text.slice(step.typedFrom)) {
          if (skipped) break;
          await this.write(character); if (character !== '\n') await pause(character === ' ' ? 22 : 38);
        }
      }
      if (step.inverse) await this.write('\x1b[27m');
      await pause(step.delay);
    }
    this.screen.classList.remove('retro-tape-border-header', 'retro-tape-border-data');
    delete this.screen.dataset.tapeBorder; delete this.screen.dataset.bootStep;
    this.stopSound();
    this.booting = false;
    if (this.challenge) { await this.write(this.profile.auth.required); this.prompt(); }
  }
}
