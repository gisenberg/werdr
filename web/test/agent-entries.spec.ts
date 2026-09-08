import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('agent rail follows native transition priority and searches workspace and tab context', async ({ page }) => {
  const runtime = await fixture();
  try {
    const panes: { pane_id: string; workspace_id: string; tab_id: string }[] = [];
    for (let index = 0; index < 4; index++) panes.push(JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane);
    const report = (index: number, state: string, seq: number) => runtime.cli('pane', 'report-agent', panes[index].pane_id, '--source', 'werdr-order-test', '--agent', 'Claude', '--state', state, '--seq', String(seq));
    await report(0, 'working', 1);
    await report(1, 'working', 1);
    await report(1, 'idle', 2);
    await report(2, 'working', 1);
    await report(2, 'idle', 2);
    await runtime.cli('workspace', 'rename', panes[1].workspace_id, 'Mercury review');
    await page.goto(runtime.url);
    await consoleInput(page, 'token', runtime.token);
    await expect(page.locator('#boot')).toBeHidden();
    const rows = page.locator('#agents button');
    const order = () => rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id));
    await expect.poll(order).toEqual([2, 1, 0].map(index => `local/${panes[index].pane_id}`));
    await report(1, 'blocked', 3);
    await expect.poll(order).toEqual([1, 2, 0].map(index => `local/${panes[index].pane_id}`));
    await page.locator('#fleet-search').fill('mercury');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('title', /Mercury review/);
    await rows.click();
    await expect(page).toHaveURL(new RegExp(`pane=${encodeURIComponent(panes[1].pane_id)}`));
    await page.locator('#fleet-search').fill('');
    await page.locator('#agent-filter').selectOption('done');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-id', `local/${panes[2].pane_id}`);
  } finally { await runtime.close(); }
});
