import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });

async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const created = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'workspace.create');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const id = (await (await created).json()).root_pane.pane_id as string;
  await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', id); await expect(page.locator('#shield')).toBeHidden();
  return id;
}
// A raw-mode reader reports every byte in hex exactly as the application receives it,
// including control characters that a shell's line discipline would act on.
const READER = `import os, termios, tty
old = termios.tcgetattr(0)
tty.setraw(0)
print('READY', end='\\r\\n', flush=True)
try:
    while True:
        byte = os.read(0, 1)
        print('KEY_' + byte.hex(), end='\\r\\n', flush=True)
        if byte == b'q':
            break
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
`;
async function reader(id: string) {
  const path = resolve(runtime.directory, 'keys.py'); await writeFile(path, READER);
  await runtime.cli('pane', 'send-text', id, `python3 ${path}\n`);
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('READY');
}
const received = (id: string) => runtime.cli('pane', 'read', id, '--source', 'recent');
const keys = (output: string) => [...output.matchAll(/KEY_([0-9a-f]{2})/g)].map(match => match[1]);

test('phone key row sends escape, tab, arrows, latched chords and paste without leaving the terminal', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const id = await create(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.locator('#terminal-key-row');
  await expect(row).toBeVisible();
  await page.locator('.pane-active canvas').first().evaluate(node => { (node as any).keyRowIdentity = 'retained'; });
  for (const button of await row.getByRole('button').all()) {
    const box = (await button.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(30);
  }
  const rowBox = (await row.boundingBox())!, terminal = (await page.locator('#terminal').boundingBox())!;
  expect(rowBox.y).toBeGreaterThanOrEqual(terminal.y + terminal.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader(id);
  const textarea = page.locator('.pane-active textarea');
  await textarea.focus();
  await row.getByRole('button', { name: 'Escape' }).click();
  await row.getByRole('button', { name: 'Tab' }).click();
  await row.getByRole('button', { name: 'Up arrow' }).click();
  await expect(textarea).toBeFocused();
  await expect.poll(async () => keys(await received(id))).toEqual(['1b', '09', '1b', '5b', '41']);

  // A soft keyboard commits text through input events, not physical key events.
  const control = row.getByRole('button', { name: 'Control modifier' });
  await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.insertText('c');
  await expect(control).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => keys(await received(id)).slice(5)).toEqual(['03']);
  const alt = row.getByRole('button', { name: 'Alt modifier' });
  await alt.click(); await page.keyboard.insertText('x');
  await expect(alt).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => keys(await received(id)).slice(6)).toEqual(['1b', '78']);
  // Tapping a modifier twice cancels it; the next character is unmodified.
  await control.click(); await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.insertText('d');
  await expect.poll(async () => keys(await received(id)).slice(8)).toEqual(['64']);

  await page.evaluate(() => navigator.clipboard.writeText('pz'));
  await row.getByRole('button', { name: 'Paste clipboard text' }).click();
  await expect.poll(async () => keys(await received(id)).slice(9)).toEqual(['70', '7a']);
  await expect(textarea).toBeFocused();
  expect(await page.locator('.pane-active canvas').first().evaluate(node => (node as any).keyRowIdentity)).toBe('retained');
  await page.screenshot({ path: 'test-results/terminal-keys-mobile.png' });
  await page.keyboard.insertText('q');

  // Desktop layouts with fine pointers retain the native chrome without a key row.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(row).toBeHidden();
});
