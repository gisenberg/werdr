import { test, expect } from '@playwright/test';
import { RETRO_BOOT_PROFILES } from '../src/wmux/retro-boot-profiles';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(true); });
test.afterAll(async () => { await runtime.close(); });
for (const [index, profile] of RETRO_BOOT_PROFILES.entries()) for (const width of [1440, 390]) {
  test(`${profile.id} authenticates without changing display geometry at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(({ index, count }) => { localStorage.removeItem('werdr-last-boot'); Math.random = () => (index + .1) / count; }, { index, count: RETRO_BOOT_PROFILES.length });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url);
    await expect(page.locator('#boot')).toHaveAttribute('data-boot-profile', profile.id);
    await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
    const before = await page.locator('#boot-frame').boundingBox();
    await consoleInput(page, 'username', 'sample-user');
    await consoleInput(page, 'password', 'secret-input', false);
    expect(await page.locator('#boot-frame').boundingBox()).toEqual(before);
    expect(await page.locator('#boot-output').textContent()).not.toContain('secret-input');
    await expect(page.locator('#boot textarea')).toHaveValue('');
    if (profile.graphicalShell) {
      await expect(page.locator('.retro-graphical-login')).toBeVisible();
      await expect(page.locator('.retro-graphical-field').first()).toHaveText('sample-user');
      await expect(page.locator('.retro-graphical-field').last()).toHaveText('••••••••••••');
    }
    if (process.env.WERDR_TEST_BOOT_FONT_DIR) expect(await page.evaluate(family => document.fonts.check(`16px ${family}`), profile.fontFamily)).toBe(true);
    await page.screenshot({ path: `test-results/profiles/${profile.id}-${width}.png` });
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(page.locator(profile.graphicalShell ? '.retro-graphical-login' : '#boot-terminal canvas')).toBeInViewport({ ratio: .99 });
    expect(errors).toEqual([]);
  });
}

for (const id of ['acorn-archimedes', 'atari-st', 'amiga-workbench', 'amiga-guru-meditation', 'msx2', 'apple-lisa', 'sgi-irix', 'nextcube', 'os2-warp']) {
  test(`${id} preserves artwork and desktop transitions`, async ({ page }) => {
    const index = RETRO_BOOT_PROFILES.findIndex(profile => profile.id === id);
    await page.addInitScript(({ index, count }) => { localStorage.removeItem('werdr-last-boot'); Math.random = () => (index + .1) / count; }, { index, count: RETRO_BOOT_PROFILES.length });
    await page.goto(runtime.url);
    const frame = page.locator('#boot-frame');
    if (id === 'amiga-guru-meditation') {
      await expect(page.locator('#boot')).toHaveAttribute('data-boot-phase', 'guru');
      await page.screenshot({ path: 'test-results/profiles/amiga-guru-startup.png' });
      await page.getByRole('button', { name: 'Continue after Amiga Guru Meditation' }).click();
      await expect(page.locator('#boot')).toHaveAttribute('data-boot-phase', 'blank');
    }
    await expect(page.locator('#boot')).toHaveAttribute('data-boot-phase', 'artwork');
    const before = await frame.boundingBox();
    if (id.startsWith('amiga-') || id === 'msx2') {
      test.skip(id.startsWith('amiga-') && !process.env.WERDR_TEST_BOOT_ASSET_DIR, 'Private Workbench screenshot is provisioned by the deployment.');
      await expect.poll(() => page.locator('.retro-boot-artwork canvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
      })).toBe(true);
    } else {
      for (const img of await page.locator('#boot-visual img').all()) expect(await img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    }
    if (['nextcube', 'sgi-irix', 'os2-warp'].includes(id)) {
      const logo = await page.locator('.retro-graphical-logo-boot img').boundingBox();
      expect(logo!.width).toBeGreaterThan(id === 'nextcube' ? 80 : id === 'sgi-irix' ? 130 : 300);
    }
    await page.screenshot({ path: `test-results/profiles/${id}-startup.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
    expect(await frame.boundingBox()).toEqual(before);
  });
}

test('Spectrum tape borders end before credential input', async ({ page }) => {
  await page.addInitScript(() => { localStorage.removeItem('werdr-last-boot'); Math.random = () => 7.1 / 36; });
  await page.goto(runtime.url);
  await expect(page.locator('#boot')).toHaveAttribute('data-tape-border', 'header');
  await page.screenshot({ path: 'test-results/profiles/spectrum-tape-header.png' });
  await expect(page.locator('#boot')).toHaveAttribute('data-tape-border', 'data');
  await page.keyboard.press('Escape');
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  await expect(page.locator('#boot')).not.toHaveAttribute('data-tape-border');
});

test('graphical login supports password, token, and logout without changing its desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { localStorage.removeItem('werdr-last-boot'); Math.random = () => 18.1 / 36; });
  await page.goto(runtime.url);
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  const before = await page.locator('#boot-frame').boundingBox();
  await consoleInput(page, 'username', runtime.username);
  await consoleInput(page, 'password', runtime.password);
  await expect(page.locator('#boot')).not.toBeVisible();
  await page.getByRole('button', { name: '[X] SIGN OUT', exact: true }).click();
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  expect(await page.locator('#boot-frame').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'USE ACCESS TOKEN', exact: true }).click();
  await consoleInput(page, 'token', runtime.token);
  await expect(page.locator('#boot')).not.toBeVisible();
});

for (const blocked of [false, true]) test(`POST audio ${blocked ? 'stays silent when autoplay is blocked' : 'plays once before authentication'}`, async ({ page }) => {
  await page.addInitScript(blocked => {
    localStorage.removeItem('werdr-last-boot'); Math.random = () => 3.1 / 36;
    const state = { starts: 0, closes: 0 };
    Object.assign(window, { werdrAudioTest: state });
    const parameter = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
    class Node {
      frequency = parameter; gain = parameter; type = '';
      connect() { return this; }
      start() { state.starts++; }
      stop() {}
    }
    Object.defineProperty(window, 'AudioContext', { value: class {
      state = 'suspended'; currentTime = 0; destination = new Node();
      async resume() { if (blocked) throw new Error('Autoplay blocked'); this.state = 'running'; }
      async close() { this.state = 'closed'; state.closes++; }
      createOscillator() { return new Node(); }
      createGain() { return new Node(); }
      createBiquadFilter() { return new Node(); }
    } });
  }, blocked);
  await page.goto(runtime.url);
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  const audioState = () => page.evaluate(() => (window as unknown as { werdrAudioTest: { starts: number; closes: number } }).werdrAudioTest);
  expect((await audioState()).starts).toBe(blocked ? 0 : 1);
  expect((await audioState()).closes).toBe(1);
  await consoleInput(page, 'username', 'user');
  await consoleInput(page, 'password', 'private', false);
  expect((await audioState()).starts).toBe(blocked ? 0 : 1);
});
