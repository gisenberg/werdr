import type { AgentStatus } from '../shared/fleet';
import type { TokenStyle } from '../shared/sidebar-tokens';

export interface RowToken { kind: string; text: string; style: TokenStyle; runs?: { text: string; tone?: 'green' | 'red' }[] }
const symbols: Record<AgentStatus, string> = { blocked: '×', working: '◐', done: '✓', idle: '○', unknown: '·' };
export function rowStatusIcon(status: AgentStatus, indicators: 'text' | 'dots' | 'symbols'): string {
  return indicators === 'text' ? `[${status.toUpperCase()}]` : indicators === 'symbols' ? symbols[status] : status === 'idle' ? '○' : status === 'unknown' ? '·' : '●';
}

const rendered = new WeakMap<HTMLElement, string>();
// Match src/ui/sidebar.rs: reserve icons and separators, give text one cell,
// retain later text fields first when necessary, then distribute spare cells fairly.
export function sidebarTokenWidths(tokens: { kind: string; width: number }[], maxWidth: number): (number | null)[] {
  const fixed = tokens.map(token => token.kind === 'state_icon' || token.kind === 'git_status' ? token.width : 0);
  const flexible = tokens.map(token => token.kind === 'state_icon' || token.kind === 'git_status' ? 0 : token.width);
  const active = tokens.map(() => true);
  const indices = () => active.flatMap((visible, index) => visible ? [index] : []);
  const separators = (visible: number[]) => visible.slice(1).reduce((sum, current, index) => sum + rowSeparator(tokens[visible[index]].kind, tokens[current].kind).length, 0);
  const minimum = () => { const visible = indices(); return separators(visible) + visible.reduce((sum, index) => sum + fixed[index] + Number(flexible[index] > 0), 0); };
  if (minimum() > maxWidth) {
    flexible.forEach((width, index) => { if (width) active[index] = false; });
    for (let index = tokens.length - 1; index >= 0; index--) {
      if (!flexible[index]) continue;
      active[index] = true; if (minimum() > maxWidth) active[index] = false;
    }
  }
  const visible = indices(), widths = flexible.map((width, index) => Number(active[index] && width > 0));
  let remaining = Math.max(0, Math.floor(maxWidth) - separators(visible) - visible.reduce((sum, index) => sum + fixed[index] + widths[index], 0));
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < widths.length && remaining > 0; index++) if (widths[index] && widths[index] < flexible[index]) { widths[index]++; remaining--; grew = true; }
    if (!grew) break;
  }
  return widths.map((width, index) => active[index] ? width + fixed[index] : null);
}
let observer: ResizeObserver | undefined;
let measure: CanvasRenderingContext2D | null | undefined;
function fitRows(node: HTMLElement) {
  if (!node.isConnected || !node.clientWidth) return;
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return;
  const style = getComputedStyle(node); measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const cell = measure.measureText('M').width;
  if (!cell) return;
  for (const row of node.querySelectorAll<HTMLElement>('.agent-line')) {
    const spans = [...row.querySelectorAll<HTMLElement>('.agent-token')];
    const prefix = row.querySelector<HTMLElement>('.row-prefix');
    const widths = sidebarTokenWidths(spans.map(span => ({ kind: span.dataset.token!, width: Math.ceil(measure!.measureText(span.textContent || '').width / cell - .001) })), Math.floor((row.clientWidth - parseFloat(getComputedStyle(row).paddingLeft) - (prefix?.getBoundingClientRect().width || 0)) / cell));
    let previous: HTMLElement | undefined;
    spans.forEach((span, index) => {
      span.hidden = widths[index] === null;
      span.style.width = widths[index] === null ? '' : `${widths[index]}ch`;
      const separator = span.previousElementSibling as HTMLElement | null;
      if (separator?.classList.contains('agent-separator')) { separator.hidden = span.hidden || !previous; separator.textContent = rowSeparator(previous?.dataset.token, span.dataset.token); }
      if (!span.hidden) previous = span;
    });
  }
}
export function forgetSidebarRows(node: HTMLElement) { observer?.unobserve(node); rendered.delete(node); }
export function rowSeparator(previous: string | undefined, current: string | undefined): string {
  return previous === 'state_icon' || current === 'git_status' ? ' ' : ' · ';
}
export function renderSidebarRows(node: HTMLElement, rows: RowToken[][], context?: { host: string; prefix: string; continuation: string }) {
  const signature = JSON.stringify([rows, context]);
  if (rendered.get(node) === signature) return;
  rendered.set(node, signature);
  const fragment = document.createDocumentFragment();
  rows.forEach((tokens, index) => {
    const row = document.createElement('span'); row.className = 'agent-line'; row.dataset.line = String(index);
    if (context?.prefix) {
      const prefix = document.createElement('span'); prefix.className = 'row-prefix'; prefix.setAttribute('aria-hidden', 'true');
      prefix.textContent = index ? context.continuation : context.prefix; row.append(prefix);
    }
    tokens.forEach((token, tokenIndex) => {
      if (tokenIndex) {
        const separator = document.createElement('span'); separator.className = 'agent-separator';
        separator.textContent = rowSeparator(tokens[tokenIndex - 1].kind, token.kind); row.append(separator);
      }
      const span = document.createElement('span'); span.className = 'agent-token'; span.dataset.token = token.kind; span.textContent = token.text;
      if (token.runs) {
        span.replaceChildren(...token.runs.map(run => {
          const part = document.createElement('span'); part.textContent = run.text;
          if (run.tone && !token.style.fg) part.style.color = `var(--herdr-${run.tone})`;
          return part;
        }));
      }
      if (token.style.fg) span.style.color = token.style.fg;
      if (token.style.bold !== undefined) span.style.fontWeight = token.style.bold ? '700' : '400';
      if (token.style.dim !== undefined) span.dataset.dim = String(token.style.dim);
      row.append(span);
    });
    fragment.append(row);
  });
  if (context) {
    const host = document.createElement('span'); host.className = 'workspace-host'; host.textContent = `${rows.length ? context.continuation : context.prefix}${context.host}`; fragment.append(host);
  }
  node.replaceChildren(fragment);
  observer ??= new ResizeObserver(entries => { for (const entry of entries) fitRows(entry.target as HTMLElement); });
  observer.observe(node);
  fitRows(node);
}
