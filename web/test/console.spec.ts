import { test, expect } from '@playwright/test';
import { fixture } from './fixture';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(true); });
test.afterAll(async () => { await runtime.close(); });

for (const [index, family, file] of [
  [0, 'C64 Pro Mono', '/fonts/c64/C64_Pro_Mono-STYLE.woff2'],
  [1, 'Retro Apple II', '/fonts/retro/Apple_2.woff2'],
  [2, 'Retro IBM CGA', '/fonts/retro/IBM_CGA.woff2'],
] as const) {
  test(`${family} retains its actual font and console through username and password prompts`, async ({ page }) => {
    test.skip(index > 0 && !process.env.WERDR_TEST_BOOT_FONT_DIR, 'Private embedded fonts are provisioned by the deployment, outside the public repository.');
    await page.addInitScript(index => { localStorage.removeItem('werdr-last-boot'); Math.random = () => (index + .1) / 3; }, index);
    await page.goto(runtime.url);
    await expect(page.locator('#boot-output')).not.toBeEmpty();
    expect(await page.locator('#boot').evaluate(node => getComputedStyle(node).fontFamily)).toContain(family);
    await expect(page.locator('#username')).toBeVisible();
    expect(await page.evaluate(family => [...document.fonts].some(face => face.family.replaceAll('"', '') === family && face.status === 'loaded'), family)).toBe(true);
    const response = await page.request.get(runtime.url + file);
    expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('font/woff2');
    expect((await response.body()).subarray(0, 4).toString()).toBe('wOF2');
    await page.locator('#username').fill('console-user'); await page.locator('#username').press('Enter');
    await expect(page.locator('#password')).toBeFocused();
    await page.locator('#password').fill('not-a-real-password');
    expect(await page.locator('#boot').innerText()).not.toContain('not-a-real-password');
    expect(await page.locator('#password').evaluate(node => getComputedStyle(node).fontFamily)).toContain(family);
    await page.screenshot({ path: `test-results/console-${index}.png` });
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(page.locator('#password')).toBeInViewport();
    expect(await page.locator('#boot').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator('#password').evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
    await page.screenshot({ path: `test-results/console-mobile-${index}.png` });
  });
}

test('an unavailable optional font cannot block credential entry', async ({ page }) => {
  await page.addInitScript(() => { localStorage.removeItem('werdr-last-boot'); Math.random = () => .4; });
  await page.route('**/fonts/retro/*.woff2', route => route.abort());
  await page.goto(runtime.url);
  await expect(page.locator('#username')).toBeVisible();
  await page.locator('#username').fill(runtime.username); await page.locator('#username').press('Enter');
  await page.locator('#password').fill(runtime.password); await page.locator('#password').press('Enter');
  await expect(page.locator('#boot')).not.toBeVisible();
  await page.getByRole('button', { name: '[X] SIGN OUT', exact: true }).click();
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#username')).toHaveValue('');
  await expect(page.locator('#password')).toHaveValue('');
  expect(await page.locator('#boot').evaluate(node => getComputedStyle(node).fontFamily)).toContain('Retro Apple II');
});
