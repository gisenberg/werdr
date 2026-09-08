import { test, expect, type Page } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });
async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const previous = new URL(page.url()).searchParams.get('pane');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden();
  return new URL(page.url()).searchParams.get('pane')!;
}
async function transfer(page: Page, bytes = png, drop = false) {
  await page.locator('.pane-active textarea').focus();
  await page.locator('.pane-active textarea').evaluate((element, { encoded, drop }) => {
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0))], 'untrusted filename.png', { type: 'image/png' }));
    element.dispatchEvent(drop ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }) : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, { encoded: bytes.toString('base64'), drop });
}
async function waitingReader(page: Page, pane: string) {
  const marker = 'READY_' + Date.now();
  await runtime.cli('pane', 'send-text', pane, "printf 'IMAGE_%s\\n' " + marker + "; IFS= read -r image_path; printf '\\nIMAGE_PATH=%s\\n' \"$image_path\"\n");
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('IMAGE_' + marker);
  // Ensure the waiting application has reached the rendered browser too.
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/); await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
}
async function pastedPath(pane: string) {
  let path = '';
  await expect.poll(async () => {
    const text = await runtime.cli('pane', 'read', pane, '--source', 'recent');
    path = text.match(/IMAGE_PATH=(\/[^\r\n]+\.png)/)?.[1] || ''; return path;
  }).not.toBe('');
  return path;
}

test('large clipboard images preserve bytes, queue input in order, and clean host files when the controller detaches', async ({ page }) => {
  const pane = await create(page); await waitingReader(page, pane);
  const original = await page.locator('.pane-active textarea').elementHandle();
  const bytes = Buffer.concat([png, Buffer.alloc(16 * 1024 * 1024 - png.length, 77)]);
  await transfer(page, bytes); await page.keyboard.press('Enter');
  const path = await pastedPath(pane);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(page.locator('#status')).toContainText('Image sent to terminal');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.reload(); await expect(page.locator('#shield')).toBeHidden();
  await expect.poll(async () => { try { await stat(path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; } }).toBe(true);
  expect(await runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('IMAGE_PATH=');
});

test('image drops and an actual browser clipboard gesture reach native staging while text paste stays ordinary input', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const pane = await create(page); await waitingReader(page, pane);
  await transfer(page, png, true); await page.keyboard.press('Enter');
  expect(await readFile(await pastedPath(pane))).toEqual(png);
  await waitingReader(page, pane);
  const clipboard = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 3, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const actual = await (await navigator.clipboard.read())[0].getType('image/png');
    return Array.from(new Uint8Array(await actual.arrayBuffer()));
  });
  await page.keyboard.press('Control+v'); await expect(page.locator('#status')).toContainText('Image sent to terminal'); await page.keyboard.press('Enter');
  // The second path is the newest native paste, independent of the prior drop.
  let last = '';
  await expect.poll(async () => { const text = await runtime.cli('pane', 'read', pane, '--source', 'recent'); const paths = [...text.matchAll(/IMAGE_PATH=(\/[^\r\n]+\.png)/g)]; last = paths.at(-1)?.[1] || ''; return paths.length; }).toBe(2);
  expect(await readFile(last)).toEqual(Buffer.from(clipboard));
  await page.evaluate(() => navigator.clipboard.writeText("printf 'ORDINARY_%s\\n' TEXT\n"));
  await page.keyboard.press('Control+v'); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('ORDINARY_TEXT');
});

test('missing capabilities, invalid files and oversized clipboard data never become terminal text or close the attachment', async ({ page }) => {
  const images: number[] = []; let supported = false;
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => { if (!supported && JSON.parse(String(message)).type === 'terminal.capabilities') return; socket.send(message); });
    socket.onMessage(message => { if (typeof message !== 'string') images.push(message.length); server.send(message); });
  });
  await create(page);
  await transfer(page); await expect(page.locator('#status')).toContainText('updated terminal client'); expect(images).toEqual([]);
  supported = true; await page.reload(); await expect(page.locator('#shield')).toBeHidden();
  const original = await page.locator('.pane-active textarea').elementHandle();
  await transfer(page, Buffer.from('not an image')); await expect(page.locator('#status')).toContainText('PNG, JPEG'); expect(images).toEqual([]);
  await page.locator('.pane-active textarea').evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.locator('#status')).toContainText('16 MiB'); expect(images).toEqual([]); await expect(page.locator('#shield')).toBeHidden();
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
});

test('a delayed file read cannot paste into a replacement pane or attachment', async ({ page }) => {
  const images: number[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => { const server = socket.connectToServer(); socket.onMessage(message => { if (typeof message !== 'string') images.push(message.length); server.send(message); }); });
  await create(page);
  await page.locator('.pane-active textarea').focus();
  await page.evaluate(encoded => {
    const data = new DataTransfer(); const file = new File([Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0))], 'delayed.png', { type: 'image/png' });
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function() { return new Promise(resolve => { (window as any).releaseImage = () => original.call(this).then(resolve); }); };
    data.items.add(file); document.querySelector('.pane-active textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, png.toString('base64'));
  await page.locator('#split').click(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  await page.evaluate(() => (window as any).releaseImage());
  expect(images).toEqual([]); await expect(page.locator('#shield')).toBeHidden();
});
