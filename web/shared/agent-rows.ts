// Mirrors the native sidebar.agents format in src/config/sidebar.rs and rules.rs.
export const agentRowTokens = ['state_icon', 'state_text', 'machine', 'workspace', 'tab', 'pane', 'agent', 'terminal_title', 'terminal_title_stripped'] as const;
export const canonicalAgents = ['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse'] as const;
export interface TokenStyle { fg?: string; bold?: boolean; dim?: boolean }
export interface TokenRule extends TokenStyle { equals?: string; contains?: string; starts_with?: string; gt?: number; lt?: number; ignore_case?: boolean }
export type AgentRowToken = string | (TokenStyle & { token: string; rules?: TokenRule[] });
export interface AgentRows { rows: AgentRowToken[][]; rows_by_agent: Record<string, AgentRowToken[][]>; row_gap: number }
export const defaultAgentRows: AgentRows = { rows: [['state_icon', 'machine', 'workspace', 'tab'], ['agent']], rows_by_agent: {}, row_gap: 0 };
export const detailedAgentRows: AgentRows = { rows: [['state_icon', 'machine', 'workspace'], ['agent', 'state_text'], ['pane', 'terminal_title_stripped']], rows_by_agent: {}, row_gap: 1 };
const fail = (message: string): never => { throw new Error(message); };
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object.');
  const out = value as Record<string, unknown>;
  if (fields && Object.keys(out).some(key => !fields.includes(key))) fail('Unknown field.');
  return out;
}
function style(value: Record<string, unknown>) {
  if (value.fg !== undefined && (typeof value.fg !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.fg))) fail('Token colors must be #RGB or #RRGGBB.');
  for (const field of ['bold', 'dim']) if (value[field] !== undefined && typeof value[field] !== 'boolean') fail(`${field} must be true or false.`);
}
function rows(value: unknown): AgentRowToken[][] {
  if (!Array.isArray(value) || value.length > 16) fail('Use at most 16 rows.');
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length > 16) fail('Use at most 16 tokens per row.');
    for (const item of row as unknown[]) {
      const spec = typeof item === 'string' ? { token: item } : record(item, ['token', 'fg', 'bold', 'dim', 'rules']);
      if (typeof spec.token !== 'string' || !(agentRowTokens as readonly string[]).includes(spec.token) && !/^\$[a-z0-9_-]{1,32}$/i.test(spec.token)) fail('Unknown token. Custom metadata names start with $.');
      style(spec);
      if (spec.rules !== undefined) {
        if (!Array.isArray(spec.rules) || spec.rules.length > 16) fail('Use at most 16 rules per token.');
        if (spec.token === 'state_icon' && (spec.rules as unknown[]).length) fail('Rules require a text-valued token.');
        for (const item of spec.rules as unknown[]) {
          const rule = record(item, ['equals', 'contains', 'starts_with', 'gt', 'lt', 'ignore_case', 'fg', 'bold', 'dim']);
          const conditions = ['equals', 'contains', 'starts_with', 'gt', 'lt'].filter(key => Object.hasOwn(rule, key));
          if (conditions.length !== 1) fail('Each rule needs exactly one of equals, contains, starts_with, gt, lt.');
          const key = conditions[0];
          if (key === 'gt' || key === 'lt') {
            if (typeof rule[key] !== 'number' || !Number.isFinite(rule[key])) fail('Numeric thresholds must be finite.');
            if (rule.ignore_case !== undefined) fail('ignore_case applies only to text conditions.');
          } else {
            if (typeof rule[key] !== 'string') fail('Text conditions must be strings.');
            if (rule.ignore_case !== undefined && typeof rule.ignore_case !== 'boolean') fail('ignore_case must be true or false.');
          }
          style(rule);
        }
      }
    }
  }
  return structuredClone(value) as AgentRowToken[][];
}
export function validateAgentRows(value: unknown): AgentRows {
  const input = record(value, ['rows', 'rows_by_agent', 'row_gap']);
  // Keep the whole preferences request within its existing bounded endpoint.
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) fail('Agent row configuration exceeds 16 KiB.');
  const overrides = record(input.rows_by_agent === undefined ? {} : input.rows_by_agent);
  const rows_by_agent: AgentRows['rows_by_agent'] = {};
  for (const [agent, layout] of Object.entries(overrides)) {
    if (!(canonicalAgents as readonly string[]).includes(agent)) fail(`Unknown canonical agent: ${agent}.`);
    rows_by_agent[agent] = rows(layout);
  }
  const row_gap = input.row_gap === undefined ? 0 : input.row_gap;
  if (!Number.isInteger(row_gap) || (row_gap as number) < 0 || (row_gap as number) > 65535) fail('row_gap must be a whole number from 0 to 65535.');
  return { rows: rows(input.rows === undefined ? defaultAgentRows.rows : input.rows), rows_by_agent, row_gap: row_gap as number };
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
export function tokenStyle(token: AgentRowToken, text: string): TokenStyle {
  if (typeof token === 'string') return {};
  const base: TokenStyle = { fg: token.fg, bold: token.bold, dim: token.dim };
  for (const rule of token.rules || []) {
    let matches = false;
    if (rule.gt !== undefined || rule.lt !== undefined) {
      // Rust f64 parsing requires a complete finite decimal, without whitespace.
      const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
      matches = Number.isFinite(number) && (rule.gt !== undefined ? number > rule.gt : number < rule.lt!);
    } else {
      const value = rule.ignore_case ? asciiLower(text) : text;
      const expected = rule.equals ?? rule.contains ?? rule.starts_with ?? '';
      const folded = rule.ignore_case ? asciiLower(expected) : expected;
      matches = rule.equals !== undefined ? value === folded : rule.contains !== undefined ? value.includes(folded) : value.startsWith(folded);
    }
    if (matches) return { fg: rule.fg ?? base.fg, bold: rule.bold ?? base.bold, dim: rule.dim ?? base.dim };
  }
  return base;
}
