import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('setup console follows prompts through phone reflow without taking over scrollback', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen(); const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/src/style.css"><div id="fixture"></div>' }));
    await page.goto(url);
    await page.evaluate(async () => {
      const source = '/src/host-manager.ts';
      const { HostManager, hostManagerMarkup } = await import(source);
      document.querySelector('#fixture')!.innerHTML = hostManagerMarkup;
      const job = { id: 'console-fixture', target: '127.0.0.1', label: 'Console fixture', platform: 'posix', state: 'running', output: Array.from({ length: 20 }, (_, i) => `Diagnostic ${i}: remote server inspection requires explicit confirmation before any installation.`).join('\n') + '\nContinue installation? [y/N]', started: 1 };
      const manager = new HostManager(async (path: string) => path === '/api/setup/jobs' ? { jobs: [job] } : { job }, () => {});
      manager.open();
    });
    await page.getByRole('button', { name: '[RUNNING] Console fixture SETUP', exact: true }).click();
    const output = page.locator('#setup-output');
    const gap = () => output.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    await expect.poll(gap).toBeLessThan(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(gap).toBeLessThan(2);
    await expect(page.locator('#setup-input')).toBeVisible();
    await output.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => output.evaluate(node => node.scrollTop)).toBe(0);
    // Allow the scroll event to reach the follow policy before changing geometry.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.setViewportSize({ width: 430, height: 740 });
    await expect.poll(() => output.evaluate(node => node.scrollTop)).toBe(0);
    await expect.poll(gap).toBeGreaterThan(100);
    await output.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(gap).toBeLessThan(2);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.setViewportSize({ width: 390, height: 650 });
    await expect.poll(gap).toBeLessThan(2);
    await page.locator('#setup-done').click();
    await expect(page.locator('#setup-dialog')).toBeHidden();
  } finally { await server.close(); }
});

test('setup console keeps a reader in earlier output while new output arrives', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen(); const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/src/style.css"><div id="fixture"></div>' }));
    await page.goto(url);
    await page.evaluate(async () => {
      const source = '/src/host-manager.ts';
      const { HostManager, hostManagerMarkup } = await import(source);
      document.querySelector('#fixture')!.innerHTML = hostManagerMarkup;
      const job = { id: 'stream-fixture', target: '127.0.0.1', label: 'Stream fixture', platform: 'posix', state: 'running', output: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n'), started: 1 };
      (window as any).setupJob = job;
      const manager = new HostManager(async (path: string) => path === '/api/setup/jobs' ? { jobs: [job] } : { job: { ...job } }, () => {});
      manager.open();
    });
    await page.getByRole('button', { name: '[RUNNING] Stream fixture SETUP', exact: true }).click();
    const output = page.locator('#setup-output');
    const gap = () => output.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    const append = (count: number) => page.evaluate(count => { const job = (window as any).setupJob; job.output += Array.from({ length: count }, (_, i) => `\nMore ${Date.now()} ${i}`).join(''); }, count);
    await expect.poll(gap).toBeLessThan(2);
    // Following: appended output stays pinned to the newest line.
    await append(20);
    await expect.poll(() => output.evaluate(node => node.textContent!.split('\n').length)).toBe(60);
    await expect.poll(gap).toBeLessThan(2);
    // The reader's first scroll after new output stops following.
    await output.evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await append(20);
    await expect.poll(() => output.evaluate(node => node.textContent!.split('\n').length)).toBe(80);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await output.evaluate(node => node.scrollTop)).toBe(0);
  } finally { await server.close(); }
});
