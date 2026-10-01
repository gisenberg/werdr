import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
// Reads one paste of a known size in raw mode and records the payload digest.
// Bracketed-paste markers are removed when the client sends them.
const READER = (size: number, out: string) => `import hashlib, os, termios, tty
old = termios.tcgetattr(0)
tty.setraw(0)
print('READY', end='\\r\\n', flush=True)
data = b''
try:
    while len(data.replace(b'\\x1b[200~', b'').replace(b'\\x1b[201~', b'')) < ${size}:
        data += os.read(0, 65536)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
payload = data.replace(b'\\x1b[200~', b'').replace(b'\\x1b[201~', b'')
open(${JSON.stringify(out)}, 'w').write('%d %s' % (len(payload), hashlib.sha256(payload).hexdigest()))
print('DONE', len(payload), end='\\r\\n', flush=True)
`;

test('pastes far larger than one terminal message arrive intact without detaching the terminal', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const id = await create(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Multi-byte characters exercise chunk boundaries; no CR keeps the payload byte-exact in raw mode.
  const text = Array.from({ length: 16000 }, (_, index) => `line ${index} € 😀 `).join('');
  const bytes = Buffer.from(text);
  expect(bytes.length).toBeGreaterThan(300 * 1024);
  const script = resolve(runtime.directory, 'paste.py'), digest = resolve(runtime.directory, 'paste.txt');
  await writeFile(script, READER(bytes.length, digest));
  await runtime.cli('pane', 'send-text', id, `python3 ${script}\n`);
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('READY');
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.locator('.pane-active textarea').focus();
  await page.locator('#terminal-key-row').getByRole('button', { name: 'Paste clipboard text' }).click();
  await expect.poll(() => readFile(digest, 'utf8').catch(() => ''), { timeout: 30_000 }).toBe(`${bytes.length} ${createHash('sha256').update(bytes).digest('hex')}`);
  await expect(page.locator('.pane-active .pane-shield')).toBeHidden();
  await page.keyboard.insertText('echo still-attached\n');
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('still-attached');
});
