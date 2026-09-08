import { canonicalAgents, tokenStyle, type AgentRows, type TokenStyle } from '../shared/agent-rows';
import type { Agent, AgentStatus } from '../shared/fleet';

interface Context { agent: Agent; machine: string; workspace: string; tab?: string; pane?: string }
export interface RowToken { kind: string; text: string; style: TokenStyle }
const symbols: Record<AgentStatus, string> = { blocked: '×', working: '◐', done: '✓', idle: '○', unknown: '·' };
const aliases: Record<string, string> = { 'claude-code': 'claude', 'cursor-agent': 'cursor', 'devin-cli': 'devin', 'devin cli': 'devin', antigravity: 'agy', 'antigravity-cli': 'agy', 'mastra-code': 'mastracode', 'mastra code': 'mastracode', opencode2: 'opencode', 'open-code': 'opencode', 'github-copilot': 'copilot', ghcs: 'copilot', 'kimi-code': 'kimi', 'kimi code': 'kimi', 'kiro-cli': 'kiro', 'amp-local': 'amp', 'grok-build': 'grok', 'hermes-agent': 'hermes', 'kilo-code': 'kilo', 'kilo code': 'kilo', qoderclicn: 'qodercli', qoder: 'qodercli', qodercn: 'qodercli', 'qwen-code': 'qwen', 'qwen code': 'qwen', 'muse-code': 'muse', 'muse-cli': 'muse' };
function canonical(label = '') {
  const name = label.trim().toLowerCase().split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|bat)$/i, '');
  return (canonicalAgents as readonly string[]).includes(name) ? name : /^muse-bin-\d/.test(name) ? 'muse' : Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}
export function resolveAgentRows(config: AgentRows, context: Context, indicators: 'text' | 'dots' | 'symbols'): RowToken[][] {
  const { agent } = context;
  const status = agent.agent_status;
  const values: Record<string, string | undefined> = {
    state_icon: indicators === 'text' ? `[${status.toUpperCase()}]` : indicators === 'symbols' ? symbols[status] : status === 'idle' ? '○' : status === 'unknown' ? '·' : '●',
    state_text: agent.state_labels?.[status] ?? (status === 'unknown' ? 'idle' : status),
    machine: context.machine, workspace: context.workspace, tab: context.tab, pane: agent.title ?? context.pane,
    agent: agent.display_agent ?? agent.name ?? agent.agent ?? agent.title,
    terminal_title: agent.terminal_title, terminal_title_stripped: agent.terminal_title_stripped,
  };
  const id = canonical(agent.agent);
  const layout = id && Object.hasOwn(config.rows_by_agent, id) ? config.rows_by_agent[id] : config.rows;
  const rows = layout.map(row => row.flatMap(token => {
    const name = typeof token === 'string' ? token : token.token;
    const value = name.startsWith('$') ? agent.tokens && Object.hasOwn(agent.tokens, name.slice(1)) ? agent.tokens[name.slice(1)] : undefined : values[name];
    if (value === undefined) return [];
    return [{ kind: name.startsWith('$') ? 'custom' : name, text: value, style: tokenStyle(token, value) }];
  })).filter(row => row.length);
  return rows.length ? rows : [[{ kind: 'state_icon', text: values.state_icon!, style: {} }]];
}
const rendered = new WeakMap<HTMLElement, string>();
// Match src/ui/sidebar.rs: reserve icons and separators, give text one cell,
// retain later text fields first when necessary, then distribute spare cells fairly.
export function agentTokenWidths(tokens: { kind: string; width: number }[], maxWidth: number): (number | null)[] {
  const fixed = tokens.map(token => token.kind === 'state_icon' ? token.width : 0);
  const flexible = tokens.map(token => token.kind === 'state_icon' ? 0 : token.width);
  const active = tokens.map(() => true);
  const indices = () => active.flatMap((visible, index) => visible ? [index] : []);
  const separators = (visible: number[]) => visible.slice(1).reduce((sum, _, index) => sum + (tokens[visible[index]].kind === 'state_icon' ? 1 : 3), 0);
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
    const widths = agentTokenWidths(spans.map(span => ({ kind: span.dataset.token!, width: Math.ceil(measure!.measureText(span.textContent || '').width / cell - .001) })), Math.floor((row.clientWidth - parseFloat(getComputedStyle(row).paddingLeft)) / cell));
    let previous: HTMLElement | undefined;
    spans.forEach((span, index) => {
      span.hidden = widths[index] === null;
      span.style.width = widths[index] === null ? '' : `${widths[index]}ch`;
      const separator = span.previousElementSibling as HTMLElement | null;
      if (separator?.classList.contains('agent-separator')) { separator.hidden = span.hidden || !previous; separator.textContent = previous?.dataset.token === 'state_icon' ? ' ' : ' · '; }
      if (!span.hidden) previous = span;
    });
  }
}
export function forgetAgentRows(node: HTMLElement) { observer?.unobserve(node); rendered.delete(node); }
export function renderAgentRows(node: HTMLElement, rows: RowToken[][]) {
  const signature = JSON.stringify(rows);
  if (rendered.get(node) === signature) return;
  rendered.set(node, signature);
  const fragment = document.createDocumentFragment();
  rows.forEach((tokens, index) => {
    const row = document.createElement('span'); row.className = 'agent-line'; row.dataset.line = String(index);
    tokens.forEach((token, tokenIndex) => {
      if (tokenIndex) {
        const separator = document.createElement('span'); separator.className = 'agent-separator';
        separator.textContent = tokens[tokenIndex - 1].kind === 'state_icon' ? ' ' : ' · '; row.append(separator);
      }
      const span = document.createElement('span'); span.className = 'agent-token'; span.dataset.token = token.kind; span.textContent = token.text;
      if (token.style.fg) span.style.color = token.style.fg;
      if (token.style.bold !== undefined) span.style.fontWeight = token.style.bold ? '700' : '400';
      if (token.style.dim !== undefined) span.dataset.dim = String(token.style.dim);
      row.append(span);
    });
    fragment.append(row);
  });
  node.replaceChildren(fragment);
  observer ??= new ResizeObserver(entries => { for (const entry of entries) fitRows(entry.target as HTMLElement); });
  observer.observe(node);
  fitRows(node);
}
