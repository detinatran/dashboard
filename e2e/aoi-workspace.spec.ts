import { expect, test } from '@playwright/test';

test('draws, measures, watches and restores an AOI', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('aoi-e2e-seeded')) {
      localStorage.removeItem('worldmonitor.aoi.shapes.v1');
      sessionStorage.setItem('aoi-e2e-seeded', '1');
    }
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });

  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'AOI' });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const workspace = page.getByRole('complementary', { name: 'Area of interest workspace' });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByText('AOI workspace', { exact: true })).toBeVisible();

  await workspace.getByRole('button', { name: 'Box' }).click();
  await expect(workspace.getByRole('button', { name: 'Box' })).toHaveClass(/active/, { timeout: 30_000 });

  const mapSurface = page.locator('#mapContainer .maplibregl-canvas, #mapContainer .map-svg').first();
  await expect(mapSurface).toBeVisible({ timeout: 30_000 });
  const bounds = await mapSurface.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  await page.mouse.click(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.28);
  await page.mouse.click(bounds.x + bounds.width * 0.32, bounds.y + bounds.height * 0.42);

  await expect(workspace.getByText('Box 1', { exact: true })).toBeVisible();
  await expect(workspace.locator('.aoi-shape-meta')).toContainText('km');
  const watch = workspace.getByRole('button', { name: 'Watch' });
  await watch.click();
  await expect(workspace.getByRole('button', { name: 'Watching' })).toBeVisible();
  await expect(workspace.getByText('Baselines captured. New entries and exits will appear here.')).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem('worldmonitor.aoi.shapes.v1'));
  expect(stored).toContain('Box 1');

  await page.reload();
  await page.getByRole('button', { name: 'AOI' }).click();
  await expect(page.getByRole('complementary', { name: 'Area of interest workspace' })
    .getByText('Box 1', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
