import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalSelectionColors } from '../src/terminal-selection.ts';
import { defaults, palette, themeNames } from '../shared/settings.ts';

test('selection colors match the native dark and light reference styles', () => {
  // ui::panes::automatic_selection_rgb_style_is_readable_with_or_without_host_background
  for (const [background, selected, foreground] of [
    ['#eff1f5', '#acaeb0', '#000000'],
    ['#1a1b26', '#5a5b63', '#ffffff'],
    ['#2d353b', '#686e72', '#ffffff'],
  ]) assert.deepEqual(terminalSelectionColors(background), { selectionBackground: selected, selectionForeground: foreground });
});

test('selected glyphs retain readable contrast across every native palette', () => {
  const luminance = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  for (const theme of themeNames) {
    const { panel_bg } = palette({ ...defaults, theme }, false), selected = terminalSelectionColors(panel_bg);
    assert.notEqual(selected.selectionBackground, panel_bg);
    const values = [luminance(selected.selectionForeground), luminance(selected.selectionBackground)];
    assert.ok((Math.max(...values) + .05) / (Math.min(...values) + .05) >= 4.5, theme);
  }
});
