import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { MAX_CUSTOM_SOUND_BYTES } from '../shared/custom-sounds';
import { consoleInput } from './console-helpers';

test('sound file selection previews actual audio locally, cancels cleanly, and saves all event sources durably', async ({ page }) => {
  test.setTimeout(120_000);
  const runtime = await fixture();
  const done = await readFile(new URL('../../assets/sounds/done.mp3', import.meta.url)), request = await readFile(new URL('../../assets/sounds/request.mp3', import.meta.url));
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/sounds')) uploads++; });
  await page.addInitScript(() => {
    const state = (window as any).soundEvidence = { played: [] as string[], revoked: [] as string[] };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { this.addEventListener('playing', () => state.played.push(this.src), { once: true }); return play.call(this); };
    const revoke = URL.revokeObjectURL; URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
  });
  const open = async () => { await page.getByRole('button', { name: 'SETTINGS', exact: true }).click(); await page.locator('#settings-custom-sounds summary').click(); };
  const choose = async (slot: string, name: string, buffer: Buffer) => {
    await page.locator(`[data-sound-file=${slot}]`).setInputFiles({ name, mimeType: 'audio/mpeg', buffer });
    await expect(page.locator(`[data-sound-name=${slot}]`)).toHaveText(name);
  };
  const save = async () => { await page.locator('#settings-form button[type=submit]').click(); await expect(page.locator('#settings-dialog')).toBeHidden(); };
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await open(); await choose('global', 'cancelled.mp3', done);
    await page.locator('[data-sound-preview=global]').click();
    await expect.poll(() => page.evaluate(() => (window as any).soundEvidence.played.some((source: string) => source.startsWith('blob:')))).toBe(true);
    expect(uploads).toBe(0); await page.locator('#settings-cancel').click();
    await expect.poll(() => page.evaluate(() => (window as any).soundEvidence.revoked.length)).toBe(1);
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.customSounds.global).toBeNull();
    await open(); await expect(page.locator('[data-sound-name=global]')).toHaveText('BUILT-IN SOUNDS');
    await page.locator('[data-sound-file=global]').setInputFiles({ name: 'bad.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not audio') });
    await expect(page.locator('#settings-error')).toContainText('could not be decoded');
    await page.locator('[data-sound-file=global]').setInputFiles({ name: 'large.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1) });
    await expect(page.locator('#settings-error')).toContainText('up to 2 MiB');
    await choose('global', 'global.mp3', done); await choose('done', 'done.mp3', request);
    const tagged = Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), done]);
    await choose('request', 'request.mp3', tagged); expect(uploads).toBe(0);
    await page.screenshot({ path: test.info().outputPath('custom-sounds-desktop.png') });
    await save(); expect(uploads).toBe(3);
    const stored = (await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.customSounds;
    for (const [slot, bytes] of [['global', done], ['done', request], ['request', tagged]] as const) expect(await (await page.request.get(runtime.url + '/api/sounds/' + stored[slot].id)).body()).toEqual(bytes);
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await open();
    for (const slot of ['global', 'done', 'request']) await expect(page.locator(`[data-sound-name=${slot}]`)).toHaveText(`${slot}.mp3`);
    await page.locator('#settings-reset').click(); await page.locator('#settings-cancel').click(); await open();
    for (const slot of ['global', 'done', 'request']) await expect(page.locator(`[data-sound-name=${slot}]`)).toHaveText(`${slot}.mp3`);
    const response = page.waitForResponse(runtime.url + '/api/sounds/' + stored.done.id);
    await page.locator('[data-sound-preview=done]').click(); expect(await (await response).body()).toEqual(request);
    await page.locator('[data-sound-reset=request]').click(); await save();
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.customSounds.request).toBeNull();
    await page.setViewportSize({ width: 390, height: 844 }); await open();
    await page.locator('[data-sound-file=done]').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('custom-sounds-phone.png') });
    await page.locator('#settings-cancel').click();
  } finally { await runtime.close(); }
});

test('reset and cancellation during delayed sound uploads cannot commit stale settings', async ({ page }) => {
  const runtime = await fixture();
  const bytes = await readFile(new URL('../../assets/sounds/done.mp3', import.meta.url));
  let release = () => {}, entered = false, settingsWrites = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/settings')) settingsWrites++; });
  await page.route('**/api/sounds', async route => {
    entered = true;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { id: 'a'.repeat(64) } }).catch(() => {});
  });
  const open = async () => {
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await page.locator('#settings-custom-sounds summary').click();
    await page.locator('[data-sound-file=global]').setInputFiles({ name: 'draft.mp3', mimeType: 'audio/mpeg', buffer: bytes });
    await expect(page.locator('[data-sound-name=global]')).toHaveText('draft.mp3');
  };
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await open(); await page.locator('#settings-form button[type=submit]').click();
    await expect.poll(() => entered).toBe(true);
    await page.locator('[data-sound-reset=global]').click(); release();
    await expect(page.locator('#settings-error')).toContainText('Settings changed while uploading');
    await expect(page.locator('[data-sound-name=global]')).toHaveText('BUILT-IN SOUNDS');
    expect(settingsWrites).toBe(0);
    await page.locator('#settings-cancel').click();
    entered = false; await open(); await page.locator('#settings-form button[type=submit]').click();
    await expect.poll(() => entered).toBe(true);
    await page.locator('#settings-cancel').click(); release();
    await expect(page.locator('#settings-form button[type=submit]')).toBeEnabled();
    expect(settingsWrites).toBe(0);
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.customSounds.global).toBeNull();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(page.locator('#settings-error')).toBeEmpty();
  } finally { release(); await runtime.close(); }
});

test('late decoding is fenced and conflicts retain local sound drafts without overwriting settings', async ({ page }) => {
  const runtime = await fixture();
  const bytes = await readFile(new URL('../../assets/sounds/done.mp3', import.meta.url));
  await page.addInitScript(() => {
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    (window as any).holdDecode = true;
    OfflineAudioContext.prototype.decodeAudioData = function (bytes: ArrayBuffer) {
      const result = decode.call(this, bytes);
      return (window as any).holdDecode ? new Promise<AudioBuffer>((resolve, reject) => { (window as any).releaseDecode = () => { result.then(resolve, reject); }; }) : result;
    };
  });
  const open = async () => { await page.getByRole('button', { name: 'SETTINGS', exact: true }).click(); await page.locator('#settings-custom-sounds summary').click(); };
  const choose = () => page.locator('[data-sound-file=global]').setInputFiles({ name: 'draft.mp3', mimeType: 'audio/mpeg', buffer: bytes });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await open(); await choose(); await expect(page.locator('[data-sound-name=global]')).toHaveText('CHECKING AUDIO...');
    await page.locator('#settings-cancel').click(); await open();
    await page.evaluate(() => { (window as any).holdDecode = false; (window as any).releaseDecode(); });
    await expect(page.locator('[data-sound-name=global]')).toHaveText('BUILT-IN SOUNDS');
    await choose(); await expect(page.locator('[data-sound-name=global]')).toHaveText('draft.mp3');
    const current = await (await page.request.get(runtime.url + '/api/settings')).json();
    current.preferences.fontSize = 19;
    expect((await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: current })).ok()).toBe(true);
    await page.locator('#settings-form button[type=submit]').click();
    await expect(page.locator('#settings-error')).not.toBeEmpty();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('[data-sound-name=global]')).toHaveText('draft.mp3');
    const persisted = await (await page.request.get(runtime.url + '/api/settings')).json();
    expect(persisted.preferences.fontSize).toBe(19); expect(persisted.preferences.customSounds.global).toBeNull();
    await page.locator('#settings-reset').click(); await page.locator('#settings-cancel').click(); await open();
    await expect(page.locator('[data-sound-name=global]')).toHaveText('BUILT-IN SOUNDS');
    await expect(page.locator('[data-setting=fontSize]')).toHaveValue('19');
  } finally { await runtime.close(); }
});

test('a delayed committed settings response does not discard newer editor choices', async ({ page }) => {
  const runtime = await fixture();
  let release = () => {}, committed = false;
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); committed = true;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await page.locator('[data-setting=fontSize]').fill('18');
    await page.locator('#settings-form button[type=submit]').click(); await expect.poll(() => committed).toBe(true);
    await page.locator('[data-setting=fontSize]').fill('20'); release();
    await expect(page.locator('#settings-error')).toContainText('Earlier choices were saved');
    await expect(page.locator('[data-setting=fontSize]')).toHaveValue('20');
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.fontSize).toBe(18);
    await page.unroute('**/api/settings'); await page.locator('#settings-form button[type=submit]').click();
    await expect(page.locator('#settings-dialog')).toBeHidden();
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.fontSize).toBe(20);
  } finally { release(); await runtime.close(); }
});

test('browser audio permission rejection is visible and does not retry playback', async ({ page }) => {
  const runtime = await fixture();
  await page.addInitScript(() => {
    (window as any).playAttempts = 0;
    HTMLMediaElement.prototype.play = function () { ++(window as any).playAttempts; return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); };
  });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click(); await page.locator('#settings-custom-sounds summary').click();
    const bytes = await readFile(new URL('../../assets/sounds/done.mp3', import.meta.url));
    await page.locator('[data-sound-file=global]').setInputFiles({ name: 'draft.mp3', mimeType: 'audio/mpeg', buffer: bytes });
    await expect(page.locator('[data-sound-name=global]')).toHaveText('draft.mp3');
    await page.locator('[data-sound-preview=global]').click();
    await expect(page.locator('#settings-error')).toContainText('Browser blocked audio');
    expect(await page.evaluate(() => (window as any).playAttempts)).toBe(1);
  } finally { await runtime.close(); }
});

test('custom MP3 storage requires authentication and origin, preserves exact private bytes, and survives restart', async ({ request, playwright }) => {
  const runtime = await fixture(), anonymous = await playwright.request.newContext();
  const bytes = await readFile(new URL('../../assets/sounds/done.mp3', import.meta.url));
  const headers = { Origin: runtime.url, 'Content-Type': 'audio/mpeg' };
  try {
    expect((await anonymous.post(runtime.url + '/api/sounds', { headers, data: bytes })).status()).toBe(401);
    expect((await request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } })).ok()).toBe(true);
    expect((await request.post(runtime.url + '/api/sounds', { headers: { ...headers, Origin: 'https://invalid.example' }, data: bytes })).status()).toBe(403);
    expect((await request.post(runtime.url + '/api/sounds', { headers: { ...headers, 'Content-Type': 'text/plain' }, data: bytes })).status()).toBe(415);
    expect((await request.post(runtime.url + '/api/sounds', { headers, data: Buffer.from('not audio') })).status()).toBe(422);
    expect((await request.post(runtime.url + '/api/sounds', { headers, data: Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1) })).status()).toBe(413);
    const upload = await request.post(runtime.url + '/api/sounds', { headers, data: bytes }); expect(upload.ok()).toBe(true);
    const { id } = await upload.json(); expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect((await (await request.post(runtime.url + '/api/sounds', { headers, data: bytes })).json()).id).toBe(id);
    expect((await anonymous.get(runtime.url + '/api/sounds/' + id)).status()).toBe(401);
    const fetched = await request.get(runtime.url + '/api/sounds/' + id);
    expect(await fetched.body()).toEqual(bytes); expect(fetched.headers()['cache-control']).toBe('private, no-store');
    expect((await stat(join(runtime.directory, 'sounds', id + '.mp3'))).mode & 0o777).toBe(0o600);
    const state = await (await request.get(runtime.url + '/api/settings')).json();
    state.preferences.customSounds.global = { id, name: 'chosen.mp3' };
    expect((await request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: state })).ok()).toBe(true);
    expect((await request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: state })).status()).toBe(409);
    const missing = await (await request.get(runtime.url + '/api/settings')).json(); missing.preferences.customSounds.done = { id: 'e'.repeat(64), name: 'missing.mp3' };
    expect((await request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: missing })).status()).toBe(400);
    await runtime.restartGateway();
    expect(await (await request.get(runtime.url + '/api/sounds/' + id)).body()).toEqual(bytes);
    expect((await (await request.get(runtime.url + '/api/settings')).json()).preferences.customSounds.global).toEqual({ id, name: 'chosen.mp3' });
    expect((await request.post(runtime.url + '/api/logout', { headers: { Origin: runtime.url }, data: {} })).ok()).toBe(true);
    expect((await request.get(runtime.url + '/api/sounds/' + id)).status()).toBe(401);
  } finally { await anonymous.dispose(); await runtime.close(); }
});
