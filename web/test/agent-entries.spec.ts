import { connect } from 'node:net';
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

test('native agent views update the browser without a refresh and retain their order', async ({ page }) => {
  const binary = process.env.WERDR_TERMINAL_CLIENT_BIN || process.env.WERDR_TEST_HERDR_BIN;
  if (!binary) throw new Error('Agent view capability tests require a candidate runtime through WERDR_TERMINAL_CLIENT_BIN or WERDR_TEST_HERDR_BIN.');
  const runtime = await fixture(false, false, false, undefined, binary);
  const request = async (method: string, params: object = {}) => {
    const status = JSON.parse(await runtime.cli('status', '--json'));
    return await new Promise<any>((resolve, reject) => {
      const socket = connect(status.server.socket);
      let buffer = '';
      socket.setTimeout(10000, () => socket.destroy(new Error('Native request timed out')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ id: 'view-test', method, params }) + '\n'));
      socket.on('data', data => {
        buffer += data.toString();
        if (!buffer.includes('\n')) return;
        socket.destroy();
        try { const response = JSON.parse(buffer.split('\n')[0]); if (response.error) reject(new Error(response.error.message)); else resolve(response.result); } catch (error) { reject(error); }
      });
    });
  };
  try {
    const panes = [];
    for (let index = 0; index < 2; index++) {
      const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
      panes.push(pane);
      await runtime.cli('pane', 'report-agent', pane.pane_id, '--source', 'werdr-view-test', '--agent', 'Claude', '--state', 'working', '--seq', '1');
    }
    await page.goto(runtime.url);
    await consoleInput(page, 'token', runtime.token);
    await expect(page.locator('#boot')).toBeHidden();
    const rows = page.locator('#agents button');
    await expect(rows).toHaveCount(2);
    await request('agent.view.set', { source: 'test.browser', label: 'Review queue', sort: [{ field: 'workspace_order', order: 'asc' }] });
    const view = await request('agent.view.get');
    await expect(page.locator('#agent-views')).toContainText('Review queue');
    await expect.poll(() => rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id))).toEqual(view.view.pane_ids.map((id: string) => `local/${id}`));
    await request('agent.view.set', { source: 'test.browser', label: 'Only blocked', filter: { op: 'eq', field: 'status', value: 'blocked' } });
    await expect(rows).toHaveCount(0);
    await expect(page.locator('#agent-views')).toContainText('Only blocked');
    await request('agent.view.clear', { source: 'wrong.owner' });
    await expect(page.locator('#agent-views')).toContainText('Only blocked');
    await runtime.cli('pane', 'report-agent', panes[0].pane_id, '--source', 'werdr-view-test', '--agent', 'Claude', '--state', 'blocked', '--seq', '2');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-id', `local/${panes[0].pane_id}`);
    await request('agent.view.set', { source: 'test.browser', label: 'Current workspace', filter: { op: 'eq', field: 'workspace_id', value: { context: 'current_workspace_id' } } });
    await runtime.cli('workspace', 'focus', panes[1].workspace_id);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-id', `local/${panes[1].pane_id}`);
    await runtime.cli('workspace', 'focus', panes[0].workspace_id);
    await expect(rows).toHaveAttribute('data-id', `local/${panes[0].pane_id}`);
    await request('agent.view.clear', { source: 'test.browser' });
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#agent-views')).toBeHidden();
  } finally { await runtime.close(); }
});
