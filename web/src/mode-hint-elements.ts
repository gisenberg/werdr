import type { ModeHint } from './mode-hints';

/** The same semantic key/description styling on desktop and touch surfaces. */
export function modeHintElements(hints: readonly ModeHint[]): HTMLElement[] {
  return hints.map(hint => {
    const item = document.createElement('span'); item.className = 'mode-hint';
    const keys = document.createElement('kbd'); keys.textContent = hint.keys;
    item.append(keys, ` ${hint.description}`);
    return item;
  });
}
