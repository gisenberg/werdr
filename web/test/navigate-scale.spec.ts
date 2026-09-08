import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('Navigate scales across one and fifteen populated workspaces without terminal churn', async ({ page }) => {
  test.setTimeout(120_000); const runtime = await fixture();
  try {
    const panes: { workspace_id: string; tab_id: string; pane_id: string }[] = [];
    const add = async () => {
      const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane; panes.push(pane);
      await runtime.cli('pane', 'send-text', pane.pane_id, `printf 'NAV_SCALE_${panes.length}\\n'\n`);
      await runtime.cli('pane', 'report-agent', pane.pane_id, '--source', 'werdr-navigate-scale', '--agent', 'Claude', '--state', 'working', '--seq', '1');
    };
    await add(); const first = panes[0];
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: first.workspace_id, tab: first.tab_id, pane: first.pane_id }));
    await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    const original = await page.locator('.pane-active textarea').elementHandle(); const url = page.url();
    const measurements: unknown[] = [];
    for (const count of [1, 15]) {
      while (panes.length < count) await add();
      await expect(page.locator('#workspaces button[data-id]')).toHaveCount(count); await expect(page.locator('#agents button')).toHaveCount(count);
      for (const mobile of [false, true]) {
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        const before = mobile ? [] : await page.locator('#workspaces button[data-id]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        if (mobile) await page.locator('#navigate-toggle').click();
        else { await page.locator('.pane-active textarea').focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('w'); }
        if (!mobile) expect(await page.locator('#workspaces button[data-id]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))).toEqual(before);
        const sample = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('#navigate-switcher:not([hidden])') || document.querySelector<HTMLElement>('#workspaces')!;
          const references = [...root.querySelectorAll('button')];
          const times: number[] = [];
          for (let i = 0; i < 120; i++) {
            const target = document.activeElement!; const key = i % 2 ? 'ArrowUp' : 'ArrowDown'; const start = performance.now();
            target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
            root.getBoundingClientRect();
            if (i >= 20) times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          return { medianMs: times[50], p95Ms: times[95], controls: references.length, retained: references.every(node => node.isConnected) };
        });
        expect(sample.retained).toBe(true); expect(await original!.evaluate(node => node.isConnected)).toBe(true); expect(page.url()).toBe(url);
        measurements.push({ count, mobile, ...sample });
        await page.keyboard.press('Escape');
      }
    }
    console.log('Navigate fixed-geometry scaling:', JSON.stringify(measurements));
  } finally { await runtime.close(); }
});
