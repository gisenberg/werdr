import { RETRO_BOOT_PROFILES } from './wmux/retro-boot-profiles';

// Portable text profiles do not depend on restricted historical artwork/fonts.
const profiles = RETRO_BOOT_PROFILES.filter(p => ['commodore-64', 'apple-iie', 'ibm-pc-at'].includes(p.id));
export async function boot() {
  let previous: string | null = null;
  try { previous = localStorage.getItem('werdr-last-boot'); } catch {}
  const candidates = profiles.filter(p => p.id !== previous);
  const profile = candidates[Math.floor(Math.random() * candidates.length)];
  try { localStorage.setItem('werdr-last-boot', profile.id); } catch {}
  const screen = document.createElement('dialog');
  screen.id = 'boot'; screen.setAttribute('aria-label', 'Starting werdr');
  screen.style.background = profile.colors.border; screen.style.color = profile.colors.foreground;
  const display = document.createElement('pre'); display.setAttribute('aria-hidden', 'true');
  display.style.background = profile.colors.background;
  display.style.width = `${profile.columns}ch`; display.style.height = `${profile.rows * 1.25}em`;
  screen.append(display); document.body.append(screen); screen.showModal();
  const resize = () => {
    const width = Math.min(screen.clientWidth * .92, screen.clientHeight * .92 * 4 / 3);
    const fontSize = width * 3 / 4 / (profile.rows * 1.25);
    display.style.fontSize = `${fontSize}px`;
    display.style.transform = `scaleX(${width / (profile.columns * .6001 * fontSize)})`;
  };
  const observer = new ResizeObserver(resize); observer.observe(screen); resize();
  let finish!: () => void;
  const dismissed = new Promise<void>(resolve => { finish = resolve; });
  screen.addEventListener('click', () => finish());
  screen.addEventListener('keydown', event => { event.preventDefault(); finish(); });
  screen.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let stopped = false;
  const run = async () => {
    for (const step of profile.boot) {
      if (stopped) return;
      if (step.clear) display.textContent = '';
      if (step.overwrite) display.textContent = display.textContent.slice(0, display.textContent.lastIndexOf('\n') + 1);
      display.textContent += step.text.replaceAll('WMUX', 'WERDR');
      display.textContent = display.textContent.split('\n').slice(-profile.rows).join('\n');
      if (!reduced) await new Promise(resolve => setTimeout(resolve, Math.min(step.delay, 160)));
    }
    await new Promise(resolve => setTimeout(resolve, reduced ? 150 : 400));
  };
  await Promise.race([run(), dismissed]);
  stopped = true; observer.disconnect(); screen.close(); screen.remove();
}
