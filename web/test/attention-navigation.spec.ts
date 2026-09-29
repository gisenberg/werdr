import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('attention commands follow native blocked states and restore terminal focus', async ({ page }) => {
  const runtime = await fixture();
  try {
    const panes = [];
    for (let i = 0; i < 3; i++) panes.push(JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane);
    for (const pane of panes.slice(1)) await runtime.cli('pane', 'report-agent', pane.pane_id, '--source', 'werdr-attention-test', '--agent', 'Claude', '--state', 'blocked', '--seq', '1');
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: panes[0].workspace_id, tab: panes[0].tab_id, pane: panes[0].pane_id }));
    await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    const choose = async (label: string) => { await page.keyboard.press('Control+k'); await page.locator('#command-search').fill(label); await page.getByRole('button', { name: label, exact: true }).click(); };
    await choose('Next agent needing attention');
    await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(panes[1].pane_id); await expect(page.locator('.pane-active textarea')).toBeFocused();
    await choose('Next agent needing attention'); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(panes[2].pane_id);
    await choose('Previous agent needing attention'); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(panes[1].pane_id);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('agent needing attention');
    for (const pane of panes.slice(1)) await runtime.cli('pane', 'report-agent', pane.pane_id, '--source', 'werdr-attention-test', '--agent', 'Claude', '--state', 'working', '--seq', '2');
    await expect(page.getByRole('button', { name: 'Next agent needing attention', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Previous agent needing attention', exact: true })).toBeDisabled();
  } finally { await runtime.close(); }
});
