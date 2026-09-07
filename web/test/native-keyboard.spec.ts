import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('browser encodes native Kitty press, repeat, release and reset', async ({ page }) => {
  test.skip(!process.env.WERDR_TERMINAL_CLIENT_BIN, 'Requires the mode-aware terminal companion.');
  const runtime = await fixture(); const inputs: string[] = []; let flags = 0;
  try {
    await page.routeWebSocket('**/ws/terminal?*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.keyboard') flags = record.flags; socket.send(message); });
      socket.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.input') inputs.push(record.text); else server.send(message); });
    });
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = new URL(page.url()).searchParams.get('pane')!;
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[>31uKEYBOARD_%s\\n' READY\n");
    await expect.poll(() => flags).toBe(31); await page.locator('.pane-active textarea').focus(); inputs.length = 0;
    await page.keyboard.down('a'); await page.keyboard.down('a'); await page.keyboard.up('a');
    await expect.poll(() => inputs.length).toBe(3);
    expect(inputs[0]).toMatch(/^\x1b\[97.*u$/);
    expect(inputs[1]).toContain(':2'); expect(inputs[2]).toContain(':3');
    inputs.length = 0;
    await page.keyboard.down('Shift'); await page.keyboard.down('A'); await page.keyboard.up('Shift'); await page.keyboard.up('A');
    await expect.poll(() => inputs.some(text => /^\x1b\[97.*;1:3.*u$/.test(text))).toBe(true);
    inputs.length = 0;
    await page.keyboard.down('b'); await page.locator('.pane-active .pane-title').focus();
    await expect.poll(() => inputs.some(text => /^\x1b\[98.*:3.*u$/.test(text))).toBe(true);
    await page.keyboard.up('b'); await page.locator('.pane-active textarea').focus();
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[<uKEYBOARD_%s\\n' RESET\n");
    await expect.poll(() => flags).toBe(0); inputs.length = 0;
    await page.keyboard.press('a'); await expect.poll(() => inputs).toEqual(['a']);
  } finally { await runtime.close(); }
});
