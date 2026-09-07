import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });

test('native scrollback search reads exact selections and rejects content changes', async ({ request }) => {
  const headers = { Origin: runtime.url };
  expect((await request.post(runtime.url + '/api/login', { headers, data: { token: runtime.token } })).ok()).toBe(true);
  await expect.poll(async () => ((await (await request.get(runtime.url + '/api/fleet')).json()).hosts as any[]).some(host => host.machine.id === 'local' && host.connection === 'online')).toBe(true);
  const action = (data: object) => request.post(runtime.url + '/api/action', { headers, data: { machine: 'local', ...data } });
  const created = await action({ action: 'workspace.create', label: 'Copy API fixture' });
  expect(created.ok(), await created.text()).toBe(true);
  const id = (await created.json()).root_pane.pane_id;
  const command = "for i in $(seq 1 200); do printf 'COPY_NATIVE_%03d 東京\\n' \"$i\"; done";
  await runtime.cli('pane', 'send-text', id, command + '\n');
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('COPY_NATIVE_200');
  const acquire = async () => {
    const response = await action({ action: 'pane.copy_motion', id, cursor: { row: 0, col: 0 }, motion: 'line_end' });
    expect(response.ok()).toBe(true); return (await response.json()).content_revision;
  };
  let revision = await acquire();
  // The shell prompt may follow the final output chunk. Wait for its revision.
  await expect.poll(async () => { const next = await acquire(), stable = next === revision && next % 2 === 0; revision = next; return stable; }).toBe(true);
  const context = await action({ action: 'pane.copy_context', id }); expect(context.ok()).toBe(true);
  const geometry = await context.json(); expect(geometry.content_revision).toBe(revision); expect(geometry.scroll.max_offset_from_bottom).toBeGreaterThan(100);
  const search = await action({ action: 'pane.copy_search', id, cursor: { row: 0, col: 0 }, query: 'COPY_NATIVE_001 東京', direction: 'forward', content_revision: revision });
  expect(search.ok()).toBe(true);
  const matches = await search.json(); expect(matches.total).toBe(1);
  const match = matches.matches[matches.current ?? 0];
  const copied = await action({ action: 'pane.selection.read', id, anchor: match.start, cursor: match.end, content_revision: revision });
  expect(copied.ok()).toBe(true); expect((await copied.json()).text).toContain('COPY_NATIVE_001 東京');
  await runtime.cli('pane', 'send-text', id, "printf 'CONTENT_CHANGED\\n'\n");
  await expect.poll(acquire).not.toBe(revision);
  const stale = await action({ action: 'pane.selection.read', id, anchor: match.start, cursor: match.end, content_revision: revision });
  expect(stale.ok()).toBe(false); expect(await stale.text()).toMatch(/content changed|stale_content/i);
  const missing = await action({ action: 'pane.selection.read', id, anchor: match.start, cursor: match.end }); expect(missing.status()).toBe(400);
  const scroll = await action({ action: 'pane.scroll', id, offset_from_bottom: 20 }); expect(scroll.ok()).toBe(true);
  await action({ action: 'pane.scroll', id, offset_from_bottom: 0 });
});
