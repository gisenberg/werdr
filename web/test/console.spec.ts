import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(true); });
test.afterAll(async () => { await runtime.close(); });

for (const [index, family, file] of [
  [0, 'C64 Pro Mono', '/fonts/c64/C64_Pro_Mono-STYLE.woff2'],
  [1, 'Retro Apple II', '/fonts/retro/Apple_2.woff2'],
  [2, 'Retro IBM CGA', '/fonts/retro/IBM_CGA.woff2'],
] as const) {
  for (const width of [1440, 390]) test(`${family} keeps the same terminal geometry through auth at ${width}px`, async ({ page }) => {
    test.skip(index > 0 && !process.env.WERDR_TEST_BOOT_FONT_DIR, 'Private embedded fonts are provisioned by the deployment.');
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(index => { localStorage.removeItem('werdr-last-boot'); Math.random = () => (index + .1) / 3; }, index);
    await page.goto(runtime.url);
    await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'boot');
    await expect(page.locator('#boot-output')).not.toBeEmpty();
    const canvas = await page.locator('#boot canvas').elementHandle();
    const metrics = () => canvas!.evaluate(node => ({ width: (node as HTMLCanvasElement).width, height: (node as HTMLCanvasElement).height, style: node.getAttribute('style'), rect: node.getBoundingClientRect().toJSON() }));
    const before = await metrics();
    const frame = await page.locator('#boot-frame').boundingBox();
    await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
    expect(await metrics()).toEqual(before);
    expect(await page.locator('#boot-frame').boundingBox()).toEqual(frame);
    expect(await page.evaluate(family => [...document.fonts].some(face => face.family.replaceAll('"', '') === family && face.status === 'loaded'), family)).toBe(true);
    const response = await page.request.get(runtime.url + file);
    expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('font/woff2');
    await consoleInput(page, 'username', 'console-user');
    await consoleInput(page, 'password', 'not-a-real-password', false);
    expect(await metrics()).toEqual(before);
    expect(await page.locator('#boot-output').textContent()).not.toContain('not-a-real-password');
    await expect(page.locator('#boot textarea')).toHaveValue('');
    await page.screenshot({ path: `test-results/console-${index}-${width}.png` });
    await page.setViewportSize({ width: 390, height: 400 });
    // Ghostty deliberately hides its input textarea; the complete canvas, including the cursor row, must stay visible.
    await expect(page.locator('#boot canvas')).toBeInViewport({ ratio: .99 });
    const fitted = await page.locator('#boot-frame').boundingBox();
    const visible = await canvas!.boundingBox();
    expect(Math.abs(visible!.width - fitted!.width)).toBeLessThan(1);
    expect(Math.abs(visible!.height - fitted!.height)).toBeLessThan(1);
    const resized = await metrics(); expect(resized.width).toBe(before.width); expect(resized.height).toBe(before.height);
    await page.screenshot({ path: `test-results/console-keyboard-${index}-${width}.png` });
  });
}

test('missing fonts cannot block terminal authentication and logout clears secret input', async ({ page }) => {
  await page.addInitScript(() => { localStorage.removeItem('werdr-last-boot'); Math.random = () => .4; });
  await page.route('**/fonts/retro/*.woff2', route => route.abort());
  await page.goto(runtime.url);
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  const before = await page.locator('#boot canvas').boundingBox();
  await consoleInput(page, 'username', runtime.username); await consoleInput(page, 'password', runtime.password);
  await expect(page.locator('#boot')).not.toBeVisible();
  await page.getByRole('button', { name: '[X] SIGN OUT', exact: true }).click();
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  await expect(page.locator('#boot textarea')).toHaveValue('');
  expect(await page.locator('#boot canvas').boundingBox()).toEqual(before);
  expect(await page.locator('#boot-output').textContent()).not.toContain(runtime.password);
});
