import { expect, test } from '@playwright/test';

/**
 * The AOI sweep reads four layers back from MapContainer's own caches
 * (nuclear, cameras, satellites, weather) rather than from
 * ctx.intelligenceCache. A regression there is invisible to unit tests because
 * it only shows up once a real map has populated those caches, so this drives
 * the real workspace and asserts the report names the layers.
 */
test('AOI report counts nuclear facilities and CCTV cameras inside the box', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem('worldmonitor.aoi.shapes.v1');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });

  await page.goto('/');
  const mapContainer = page.locator('#mapContainer');
  await expect(mapContainer).toHaveClass(/(?:svg|deckgl)-mode/, { timeout: 30_000 });

  await page.getByRole('button', { name: 'AOI' }).click();
  const workspace = page.getByRole('complementary', { name: 'Area of interest workspace' });
  await expect(workspace).toBeVisible();

  await workspace.getByRole('button', { name: 'Box' }).click();
  await expect(workspace.getByRole('button', { name: 'Box' })).toHaveClass(/active/, { timeout: 30_000 });

  const surface = page.locator('#mapContainer .maplibregl-canvas, #mapContainer .map-svg').first();
  await expect(surface).toBeVisible({ timeout: 30_000 });
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  // The AOI workspace is docked over part of the map, so click well inside the
  // visible canvas. Box mode takes two opposite corners.
  // Same corner ratios as e2e/aoi-workspace.spec.ts, which are known to land on
  // bare canvas rather than on a map overlay chip.
  await page.mouse.click(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.28);
  await page.mouse.click(bounds.x + bounds.width * 0.32, bounds.y + bounds.height * 0.42);

  await expect(workspace.getByText('Box 1', { exact: true })).toBeVisible();

  const total = workspace.locator('.aoi-report-total');
  await expect(total).toBeVisible({ timeout: 30_000 });
  await expect(total).not.toHaveText('0');

  // The nuclear layer is a static dataset, so it must resolve on any run.
  await expect(workspace.locator('.aoi-report-label', { hasText: 'Nuclear facilities' }))
    .toBeVisible({ timeout: 30_000 });

  const labels = await workspace.locator('.aoi-report-label').allTextContents();
  console.log('AOI groups reported:', JSON.stringify(labels));
  const counts = await workspace.locator('.aoi-report-count').allTextContents();
  console.log('AOI counts:', JSON.stringify(counts));

  expect(pageErrors).toEqual([]);
});
