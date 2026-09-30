import { test, expect } from '@playwright/test';
import { fixture } from './fixture';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });

test('the installable web app manifest and icons are served before sign-in', async ({ page, request }) => {
  await page.goto(runtime.url);
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifestResponse = await request.get(new URL(href!, runtime.url).href);
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toBe('application/manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ name: 'werdr', start_url: '/', scope: '/', display: 'standalone' });
  expect(manifest.icons.some((icon: { purpose?: string; sizes: string }) => icon.purpose === 'maskable' && icon.sizes === '512x512')).toBe(true);
  for (const src of [...manifest.icons.map((icon: { src: string }) => icon.src), await page.locator('link[rel=apple-touch-icon]').getAttribute('href')]) {
    const icon = await request.get(new URL(src, runtime.url).href);
    expect(icon.status(), src).toBe(200); expect(icon.headers()['content-type']).toMatch(/^image\//);
  }
});
