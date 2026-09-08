import nativeThemes from './native-themes.json';
export const themeNames = Object.keys(nativeThemes);
export const fonts = ['monospace', 'system', 'consolas', 'menlo'] as const;
export interface Preferences {
  theme: string; appearance: 'theme' | 'dark' | 'light' | 'system'; lightTheme: string; darkTheme: string;
  customColors: Record<string, string>;
  font: typeof fonts[number]; fontSize: number; cursorBlink: boolean; copyOnSelect: boolean;
  sidebarWidth: number; sidebarSectionPercent: number; compact: boolean; indicators: 'text' | 'dots' | 'symbols';
  collapsedWorkspaceGroups: string[];
  agentSort: 'priority' | 'native'; confirmClose: boolean; hideSingleTab: boolean; tabBarPosition: 'top' | 'bottom';
  paneScrollbars: boolean; paneBorders: boolean; paneOuterBorders: boolean; paneGaps: boolean; showAgentLabelsOnPaneBorders: boolean;
  notificationAttention: boolean; notificationFinished: boolean; notificationSound: boolean;
  toastSeconds: number; toastPosition: 'top-right' | 'bottom-right'; scrollLines: number;
}
export const defaults: Preferences = {
  theme: 'catppuccin', appearance: 'theme', darkTheme: 'catppuccin', lightTheme: 'catppuccin-latte', customColors: {},
  font: 'monospace', fontSize: 14, cursorBlink: false, copyOnSelect: true, sidebarWidth: 248, sidebarSectionPercent: 50, compact: true,
  indicators: 'text', agentSort: 'priority', confirmClose: true, hideSingleTab: false, tabBarPosition: 'top',
  collapsedWorkspaceGroups: [],
  paneScrollbars: true, paneBorders: true, paneOuterBorders: true, paneGaps: true, showAgentLabelsOnPaneBorders: false,
  notificationAttention: true, notificationFinished: true, notificationSound: false,
  toastSeconds: 5, toastPosition: 'top-right', scrollLines: 3,
};
export interface SettingsState { revision: number; preferences: Preferences }
export class SettingsValidationError extends Error {}
const fail = (key: string): never => { throw new SettingsValidationError(`Invalid setting: ${key}`); };
export function validatePreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('preferences');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) fail('unknown field');
  const out = { ...defaults, ...input };
  if (!Array.isArray(out.collapsedWorkspaceGroups) || out.collapsedWorkspaceGroups.length > 256 || out.collapsedWorkspaceGroups.some(key => typeof key !== 'string' || !key || key.length > 8192 || /[\x00-\x1f]/.test(key)) || new Set(out.collapsedWorkspaceGroups).size !== out.collapsedWorkspaceGroups.length || new TextEncoder().encode(JSON.stringify(out.collapsedWorkspaceGroups)).length > 32768) fail('collapsedWorkspaceGroups');
  for (const key of ['theme', 'darkTheme', 'lightTheme'] as const) if (typeof out[key] !== 'string' || !themeNames.includes(out[key])) fail(key);
  for (const [key, values] of Object.entries({ appearance: ['theme', 'dark', 'light', 'system'], font: fonts, indicators: ['text', 'dots', 'symbols'], agentSort: ['priority', 'native'], tabBarPosition: ['top', 'bottom'], toastPosition: ['top-right', 'bottom-right'] })) if (!values.includes(out[key as keyof Preferences] as never)) fail(key);
  for (const key of ['cursorBlink', 'copyOnSelect', 'compact', 'confirmClose', 'hideSingleTab', 'paneScrollbars', 'paneBorders', 'paneOuterBorders', 'paneGaps', 'showAgentLabelsOnPaneBorders', 'notificationAttention', 'notificationFinished', 'notificationSound'] as const) if (typeof out[key] !== 'boolean') fail(key);
  for (const [key, min, max] of [['fontSize', 10, 32], ['sidebarWidth', 160, 640], ['sidebarSectionPercent', 10, 90], ['toastSeconds', 0, 60], ['scrollLines', 1, 20]] as const) if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) fail(key);
  if (!out.customColors || typeof out.customColors !== 'object' || Array.isArray(out.customColors)) fail('customColors');
  const allowedColors = Object.keys(nativeThemes.catppuccin);
  for (const [key, color] of Object.entries(out.customColors)) if (!allowedColors.includes(key) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail(`customColors.${key}`);
  return { ...out, customColors: { ...out.customColors }, collapsedWorkspaceGroups: [...out.collapsedWorkspaceGroups] };
}
const terminalColors: Record<string, string> = { Blue: '#3465a4', DarkGray: '#555753', Gray: '#d3d7cf', White: '#eeeeec', Green: '#4e9a06', Yellow: '#c4a000', LightRed: '#ef2929', Cyan: '#06989a' };
export function palette(preferences: Preferences, systemLight: boolean): Record<string, string> {
  const light = preferences.appearance === 'light' || preferences.appearance === 'system' && systemLight;
  const name = preferences.appearance === 'theme' ? preferences.theme : light ? preferences.lightTheme : preferences.darkTheme;
  const native = nativeThemes[name as keyof typeof nativeThemes];
  const background = light ? '#ffffff' : '#14191b';
  const result: Record<string, string> = {};
  for (const [key, color] of Object.entries(native)) result[key] = color.startsWith('#') ? color : color === 'Reset' ? key === 'text' ? light ? '#222222' : '#d1ddd8' : background : terminalColors[color];
  // Native sidebar reset inherits the surrounding terminal's background.
  if (native.sidebar_bg === 'Reset' && name !== 'terminal') result.sidebar_bg = result.panel_bg;
  return { ...result, ...preferences.customColors };
}
export const fontFamilies = { monospace: 'ui-monospace, SFMono-Regular, Consolas, monospace', system: 'ui-monospace, monospace', consolas: 'Consolas, "Liberation Mono", monospace', menlo: 'Menlo, Monaco, monospace' };
