import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RetroBootArtwork, RETRO_BOOT_ARTWORK } from './wmux/RetroBootArtwork';
import { GraphicalDesktop, shellCopy } from './wmux/BootGraphics';
import type { RetroBootProfile } from './wmux/retro-boot-profiles';
import './wmux/retro-boot.css';

export type VisualPhase = 'blank' | 'artwork' | 'guru' | 'terminal';
export type AuthStage = 'boot' | 'username' | 'password' | 'token' | 'submitting' | 'ready';
export class BootPresentation {
  readonly element = document.createElement('div');
  readonly framebuffer;
  private readonly root: Root;
  constructor(private readonly profile: RetroBootProfile, private readonly acknowledge: () => void, private readonly submit: () => void) {
    this.framebuffer = RETRO_BOOT_ARTWORK[profile.id].framebuffer;
    this.element.id = 'boot-visual';
    this.root = createRoot(this.element);
  }
  render(phase: VisualPhase, stage: AuthStage, username: string, secretLength: number, message: string) {
    const profile = this.profile, shell = profile.graphicalShell;
    flushSync(() => this.root.render(shell ? <>
      <GraphicalDesktop shell={shell} booting={phase !== 'terminal'} />
      {phase === 'terminal' && stage !== 'boot' ? <div className="retro-graphical-login" role="group" aria-label={shellCopy[shell].title.replaceAll('WMUX', 'WERDR')}>
        <div className="retro-graphical-login-title">{shellCopy[shell].title.replaceAll('WMUX', 'WERDR')}</div>
        {shell === 'irix' ? <img className="retro-graphical-login-logo" src={new URL('./wmux/assets/retro/logos/sgi.svg', import.meta.url).href} alt="SGI" /> : null}
        <div className="retro-graphical-field-row"><span>{shellCopy[shell].user}</span><span className={`retro-graphical-field ${stage === 'username' ? 'is-active' : ''}`}>{username}</span></div>
        <div className="retro-graphical-field-row"><span>{stage === 'token' ? 'Access token:' : shellCopy[shell].password}</span><span className={`retro-graphical-field ${stage === 'password' || stage === 'token' ? 'is-active' : ''}`}>{'•'.repeat(Math.min(secretLength, 32))}</span></div>
        <div className="retro-graphical-message" role="status">{message}</div>
        <div className="retro-graphical-actions"><button type="button" className="is-default" disabled={stage === 'submitting' || stage === 'ready'} onClick={this.submit}>{shellCopy[shell].action}</button></div>
      </div> : null}
    </> : <>
      {profile.id.startsWith('amiga-') && phase === 'terminal' ? <div className="retro-amiga-shell-titlebar" aria-hidden="true"><span className="retro-amiga-shell-gadget">0</span><span>AmigaShell</span><span className="retro-amiga-shell-depth-gadget" /></div> : null}
      {phase === 'blank' ? <div className="retro-boot-amiga-blank" /> : null}
      {phase === 'artwork' ? <RetroBootArtwork profileId={profile.id} profileName={profile.name} /> : null}
      {phase === 'guru' ? <button type="button" className="retro-amiga-guru" aria-label="Continue after Amiga Guru Meditation" onClick={event => { event.stopPropagation(); this.acknowledge(); }}><span className="retro-amiga-guru-alert"><span>Software Failure. Press left mouse button to continue.</span><span>Guru Meditation #0000000B.00C01570</span></span></button> : null}
    </>));
  }
}
