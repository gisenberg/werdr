import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RetroBootArtwork, RETRO_BOOT_ARTWORK, retroDisplayAspect } from './wmux/RetroBootArtwork';
import { AmigaGuruAlert, GRAPHICAL_BOOT_STAGES, GRAPHICAL_DESKTOP_STAGE, GraphicalScene } from './wmux/RetroGraphicalDesktop';
import type { RetroBootProfile } from './wmux/retro-boot-profiles';
import { brandBootText } from './boot-brand';
import './wmux/retro-boot.css';
import './wmux/retro-graphical-desktop.css';

export type VisualPhase = 'blank' | 'artwork' | 'guru' | 'terminal';
export type AuthStage = 'boot' | 'username' | 'password' | 'token' | 'submitting' | 'ready';
export class BootPresentation {
  readonly element = document.createElement('div');
  readonly framebuffer;
  readonly aspect;
  readonly graphicalStages;
  private graphicalStage: string;
  private readonly root: Root;
  constructor(private readonly profile: RetroBootProfile, private readonly acknowledge: () => void, private readonly submit: () => void) {
    this.framebuffer = RETRO_BOOT_ARTWORK[profile.id].framebuffer;
    this.aspect = retroDisplayAspect(RETRO_BOOT_ARTWORK[profile.id]);
    this.graphicalStages = profile.graphicalShell ? GRAPHICAL_BOOT_STAGES[profile.graphicalShell] : [];
    this.graphicalStage = this.graphicalStages[0]?.id ?? GRAPHICAL_DESKTOP_STAGE;
    this.element.id = 'boot-visual';
    this.root = createRoot(this.element);
  }
  // Graphical startup scenes advance independently of the authentication stage.
  showGraphicalStage(stage: string) { this.graphicalStage = stage; }
  render(phase: VisualPhase, stage: AuthStage, username: string, secretLength: number, message: string) {
    const profile = this.profile, shell = profile.graphicalShell;
    flushSync(() => this.root.render(shell ? (
      <GraphicalScene
        shell={shell}
        stage={phase === 'terminal' ? GRAPHICAL_DESKTOP_STAGE : this.graphicalStage}
        brand={brandBootText}
        login={phase === 'terminal' && stage !== 'boot' ? {
          field: stage === 'username' || stage === 'password' || stage === 'token' ? stage : null,
          username, secretLength, message,
          submitDisabled: stage === 'submitting' || stage === 'ready',
          onSubmit: this.submit,
        } : undefined}
      />
    ) : <>
      {profile.id.startsWith('amiga-') && phase === 'terminal' ? <div className="retro-amiga-shell-titlebar" aria-hidden="true"><span className="retro-amiga-shell-gadget">0</span><span>AmigaShell</span><span className="retro-amiga-shell-depth-gadget" /></div> : null}
      {phase === 'blank' ? <div className="retro-boot-amiga-blank" /> : null}
      {phase === 'artwork' ? <RetroBootArtwork profileId={profile.id} profileName={profile.name} /> : null}
      {phase === 'guru' ? <button type="button" className="retro-amiga-guru" aria-label="Continue after Amiga Guru Meditation" onClick={event => { event.stopPropagation(); this.acknowledge(); }}><AmigaGuruAlert /></button> : null}
    </>));
  }
}
