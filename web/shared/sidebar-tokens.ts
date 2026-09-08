// Shared native sidebar token styles, rules, and bounded layout validation.
export interface TokenStyle { fg?: string; bold?: boolean; dim?: boolean }
export interface TokenRule extends TokenStyle { equals?: string; contains?: string; starts_with?: string; gt?: number; lt?: number; ignore_case?: boolean }
export type SidebarRowToken = string | (TokenStyle & { token: string; rules?: TokenRule[] });
export const fail = (message: string): never => { throw new Error(message); };
export function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object.');
  const out = value as Record<string, unknown>;
  if (fields && Object.keys(out).some(key => !fields.includes(key))) fail('Unknown field.');
  return out;
}
function style(value: Record<string, unknown>) {
  if (value.fg !== undefined && (typeof value.fg !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.fg))) fail('Token colors must be #RGB or #RRGGBB.');
  for (const field of ['bold', 'dim']) if (value[field] !== undefined && typeof value[field] !== 'boolean') fail(`${field} must be true or false.`);
}
export function validateSidebarRows(value: unknown, tokens: readonly string[]): SidebarRowToken[][] {
  if (!Array.isArray(value) || value.length > 16) fail('Use at most 16 rows.');
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length > 16) fail('Use at most 16 tokens per row.');
    for (const item of row as unknown[]) {
      const spec = typeof item === 'string' ? { token: item } : record(item, ['token', 'fg', 'bold', 'dim', 'rules']);
      if (typeof spec.token !== 'string' || !tokens.includes(spec.token) && !/^\$[a-z0-9_-]{1,32}$/i.test(spec.token)) fail('Unknown token. Custom metadata names start with $.');
      style(spec);
      if (spec.rules !== undefined) {
        if (!Array.isArray(spec.rules) || spec.rules.length > 16) fail('Use at most 16 rules per token.');
        if (['state_icon', 'git_status'].includes(spec.token as string) && (spec.rules as unknown[]).length) fail('Rules require a text-valued token.');
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
  return structuredClone(value) as SidebarRowToken[][];
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
export function tokenStyle(token: SidebarRowToken, text: string): TokenStyle {
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
