import { expect, test } from '@playwright/test';

test('real viewport intersection pauses offscreen maps without releasing a modal pause', async ({ page }) => {
  await page.route('**/visibility-probe.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0"><div id="map" style="height:300px"></div><div style="height:3000px"></div></body></html>',
  }));
  await page.goto('/visibility-probe.html');
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves this browser-only source import.
    const { MapRenderVisibility } = await import('/src/utils/map-render-visibility.ts');
    const probe = window as unknown as { gate: InstanceType<typeof MapRenderVisibility>; paused: boolean };
    probe.gate = new MapRenderVisibility((paused: boolean) => { probe.paused = paused; });
    probe.gate.observe(document.getElementById('map')!);
  });
  const paused = () => page.evaluate(() => (window as unknown as { paused: boolean }).paused);
  await expect.poll(paused).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 1800));
  await expect.poll(paused).toBe(true);
  await page.evaluate(() => {
    (window as unknown as { gate: { setManual: (value: boolean) => void } }).gate.setManual(true);
    window.scrollTo(0, 0);
  });
  // Wait for the real intersection observer to deliver the visible transition.
  await page.waitForTimeout(250);
  expect(await paused()).toBe(true);
  await page.evaluate(() => (window as unknown as { gate: { setManual: (value: boolean) => void } }).gate.setManual(false));
  await expect.poll(paused).toBe(false);
  await page.evaluate(() => (window as unknown as { gate: { destroy: () => void } }).gate.destroy());
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(250);
  expect(await paused()).toBe(false);
});
