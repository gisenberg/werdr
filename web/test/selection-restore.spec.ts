import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import type { FleetState, HostView } from '../shared/fleet';

test('a fresh pane link waits for fleet metadata without attaching an unrelated terminal', async ({ page }) => {
  const runtime = await fixture();
  try {
    await runtime.cli('workspace', 'create');
    const target = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    let published = false; const attachments: string[] = [];
    const filterHost = (host: HostView): HostView => {
      if (published || !host.snapshot) return host;
      const snapshot = structuredClone(host.snapshot);
      snapshot.workspaces = snapshot.workspaces.filter(item => item.workspace_id !== target.workspace_id);
      snapshot.tabs = snapshot.tabs.filter(item => item.workspace_id !== target.workspace_id);
      snapshot.panes = snapshot.panes.filter(item => item.workspace_id !== target.workspace_id);
      snapshot.agents = snapshot.agents.filter(item => item.workspace_id !== target.workspace_id);
      snapshot.layouts = snapshot.layouts.filter(item => item.tab_id !== target.tab_id);
      return { ...host, snapshot };
    };
    const filterState = (state: FleetState) => ({ ...state, hosts: state.hosts.map(filterHost) });
    await page.route('**/api/fleet', async route => { const response = await route.fetch(); await route.fulfill({ response, json: filterState(await response.json()) }); });
    await page.routeWebSocket('**/ws/fleet', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        const event = JSON.parse(String(message));
        if (event.state) event.state = filterState(event.state);
        if (event.host) event.host = filterHost(event.host);
        if (event.hosts) event.hosts = event.hosts.map(filterHost);
        socket.send(JSON.stringify(event));
      });
    });
    await page.routeWebSocket('**/ws/terminal?*', socket => { attachments.push(new URL(socket.url()).searchParams.get('pane')!); socket.connectToServer(); });
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: target.workspace_id, tab: target.tab_id, pane: target.pane_id }));
    await expect(page.locator('#boot')).toBeHidden();
    await expect(page.locator('#shield')).toContainText('Waiting for native workspace update');
    expect(new URL(page.url()).searchParams.get('pane')).toBe(target.pane_id);
    expect(attachments).toEqual([]); await expect(page.locator('.terminal-pane')).toHaveCount(0);
    published = true; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', target.pane_id);
    await expect(page.locator('#shield')).toBeHidden();
    expect(attachments).toEqual([target.pane_id]);
  } finally {
    // Finish routed reads while the fixture still serves them, then stop the
    // browser's reconnect work before shutting down its gateway.
    try { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
    finally { await runtime.close(); }
  }
});

test('missing, contradictory, and unknown-host links stay unattached until explicit navigation', async ({ page }) => {
  test.setTimeout(90_000); const runtime = await fixture();
  try {
    const first = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    const second = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    const attachments: string[] = [];
    await page.routeWebSocket('**/ws/terminal?*', socket => { attachments.push(new URL(socket.url()).searchParams.get('pane')!); socket.connectToServer(); });
    for (const target of [
      { machine: 'local', workspace: first.workspace_id, tab: first.tab_id, pane: 'missing' },
      { machine: 'local', workspace: first.workspace_id, tab: first.tab_id, pane: second.pane_id },
      { machine: 'unknown-host', workspace: first.workspace_id, tab: first.tab_id, pane: first.pane_id },
    ]) {
      attachments.length = 0;
      await page.goto(runtime.url + '/?' + new URLSearchParams(target)); await expect(page.locator('#boot')).toBeHidden();
      await expect(page.locator('#shield')).toContainText(/unavailable|IDs do not match/);
      expect(new URL(page.url()).searchParams.get('machine')).toBe(target.machine);
      expect(new URL(page.url()).searchParams.get('pane')).toBe(target.pane);
      expect(attachments).toEqual([]); await expect(page.locator('.terminal-pane')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/selection-unavailable-desktop.png' });
      if (target.machine === 'unknown-host') {
        await expect(page.locator('#status')).toContainText('[UNAVAILABLE] unknown-host');
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('#shield')).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/selection-unavailable-mobile.png' });
        await page.setViewportSize({ width: 1440, height: 900 }); expect(attachments).toEqual([]);
      }
      await page.locator(`#workspaces button[data-id="local/${first.workspace_id}"]`).click();
      await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', first.pane_id); await expect(page.locator('#shield')).toBeHidden();
      expect(attachments).toEqual([first.pane_id]);
    }
  } finally { await runtime.close(); }
});

test('workspace-only links discard saved descendants and a newer selection defeats a delayed fresh read', async ({ page }) => {
  const runtime = await fixture(); let release = () => {};
  try {
    const first = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    const second = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    await page.addInitScript(value => localStorage.setItem('werdr-selection', JSON.stringify(value)), { machine: 'unrelated-host', workspace: first.workspace_id, tab: first.tab_id, pane: first.pane_id });
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: second.workspace_id }));
    await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', second.pane_id); await expect(page.locator('#shield')).toBeHidden();
    let started = () => {}; const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/snapshot?*', async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
    const attachments: string[] = [];
    await page.routeWebSocket('**/ws/terminal?*', socket => { attachments.push(new URL(socket.url()).searchParams.get('pane')!); socket.connectToServer(); });
    await page.reload(); await waiting; await expect(page.locator('#boot')).toBeHidden();
    expect(attachments).toEqual([]);
    await page.locator(`#workspaces button[data-id="local/${first.workspace_id}"]`).click();
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', first.pane_id); await expect(page.locator('#shield')).toBeHidden();
    const finished = page.waitForResponse(response => response.url().includes('/api/snapshot?')); release(); await (await finished).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', first.pane_id); expect(attachments).toEqual([first.pane_id]);
  } finally { release(); await runtime.close(); }
});

test('an older initial fleet WebSocket snapshot cannot undo a newer HTTP restoration', async ({ page }) => {
  const runtime = await fixture();
  try {
    const first = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    await expect.poll(async () => (await (await page.request.get(runtime.url + '/api/fleet')).json()).hosts[0]?.snapshot?.panes.some((pane: { pane_id: string }) => pane.pane_id === first.pane_id)).toBe(true);
    const older = await (await page.request.get(runtime.url + '/api/fleet')).json();
    const target = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await expect.poll(async () => (await (await page.request.get(runtime.url + '/api/fleet')).json()).hosts[0]?.snapshot?.panes.some((pane: { pane_id: string }) => pane.pane_id === target.pane_id)).toBe(true);
    let deliverOlder = () => {};
    await page.routeWebSocket('**/ws/fleet', socket => {
      const server = socket.connectToServer(); server.onMessage(() => {});
      deliverOlder = () => socket.send(JSON.stringify({ type: 'fleet.snapshot', state: older }));
    });
    const attachments: string[] = [];
    await page.routeWebSocket('**/ws/terminal?*', socket => { attachments.push(new URL(socket.url()).searchParams.get('pane')!); socket.connectToServer(); });
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: target.workspace_id, tab: target.tab_id, pane: target.pane_id }));
    await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', target.pane_id); await expect(page.locator('#shield')).toBeHidden();
    deliverOlder(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', target.pane_id); expect(attachments).toEqual([target.pane_id]);
  } finally { await runtime.close(); }
});

test('a transient native selection-read failure retries without attaching a fallback pane', async ({ page }) => {
  const runtime = await fixture();
  try {
    await runtime.cli('workspace', 'create');
    const target = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    let available = false; const attachments: string[] = [];
    await page.route('**/api/snapshot?*', route => available ? route.continue() : route.fulfill({ status: 503, json: { error: 'Temporary fixture outage' } }));
    await page.routeWebSocket('**/ws/terminal?*', socket => { attachments.push(new URL(socket.url()).searchParams.get('pane')!); socket.connectToServer(); });
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: target.workspace_id, tab: target.tab_id, pane: target.pane_id }));
    await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toContainText('Unable to verify requested selection');
    expect(attachments).toEqual([]); expect(new URL(page.url()).searchParams.get('pane')).toBe(target.pane_id);
    available = true; await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', target.pane_id); await expect(page.locator('#shield')).toBeHidden();
    expect(attachments).toEqual([target.pane_id]);
  } finally { await runtime.close(); }
});
