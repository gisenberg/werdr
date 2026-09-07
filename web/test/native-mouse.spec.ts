import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('native mouse modes control browser gestures and release outside the pane', async ({ page }) => {
  test.skip(!process.env.WERDR_TERMINAL_CLIENT_BIN, 'Requires the mode-aware terminal companion.');
  const runtime = await fixture();
  const inputs: string[] = []; const scrolls: Record<string, number | string>[] = []; let enabled = false;
  try {
    await page.routeWebSocket('**/ws/terminal?*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.mouse') enabled = record.enabled; socket.send(message); });
      socket.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.scroll') { scrolls.push(record); return; } if (record.type === 'terminal.input' && record.text.startsWith('\x1b[<')) inputs.push(record.text); else server.send(message); });
    });
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = new URL(page.url()).searchParams.get('pane')!;
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[?1000h\\033[?1006hMOUSE_%s\\n' READY\n");
    await expect.poll(() => enabled).toBe(true);
    const canvas = await page.locator('.pane-active canvas').first().boundingBox(); expect(canvas).toBeTruthy();
    await page.mouse.move(canvas!.x + 25, canvas!.y + 25);
    await expect.poll(() => inputs.some(text => /^\x1b\[<35;\d+;\d+M$/.test(text))).toBe(true);
    await page.keyboard.down('Shift'); await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -90);
    await expect.poll(() => scrolls.length).toBe(1);
    expect(scrolls[0]).toMatchObject({ type: 'terminal.scroll', direction: 'up', modifiers: 5 });
    expect(Number(scrolls[0].column)).toBeGreaterThan(0); expect(Number(scrolls[0].row)).toBeGreaterThan(0);
    await page.keyboard.up('Alt'); await page.keyboard.up('Shift');
    inputs.length = 0;
    await page.mouse.down(); await page.mouse.move(canvas!.x + 60, canvas!.y + 45); await page.mouse.move(1, 1); await page.mouse.up();
    expect(inputs[0]).toMatch(/^\x1b\[<0;\d+;\d+M$/);
    expect(inputs.some(text => /^\x1b\[<32;\d+;\d+M$/.test(text))).toBe(true);
    expect(inputs.at(-1)).toBe('\x1b[<0;1;1m');
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[?1000l\\033[?1006lMOUSE_%s\\n' RESET\n");
    await expect.poll(() => enabled).toBe(false); inputs.length = 0;
    await page.mouse.move(canvas!.x + 25, canvas!.y + 25); await page.mouse.down(); await page.mouse.move(canvas!.x + 90, canvas!.y + 25); await page.mouse.up();
    expect(inputs).toEqual([]);
  } finally { await runtime.close(); }
});
