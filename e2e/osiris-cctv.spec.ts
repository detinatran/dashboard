import { expect, test } from '@playwright/test';

test('opens the nearest CCTV viewer for the selected map location', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem('worldmonitor-layers');
  });
  await page.route('https://cdn.uab.org/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#101923"/><path d="M0 420L960 270V540H0Z" fill="#263a45"/><circle cx="700" cy="250" r="18" fill="#ffd166"/></svg>',
    });
  });

  await page.goto('/?lat=42.662&lon=23.376&zoom=10');
  const mapContainer = page.locator('#mapContainer');
  await expect(mapContainer).toHaveClass(/(?:svg|deckgl)-mode/, { timeout: 30_000 });
  const mapBounds = await mapContainer.boundingBox();
  expect(mapBounds).not.toBeNull();
  if (!mapBounds) return;
  await page.mouse.click(
    mapBounds.x + mapBounds.width / 2,
    mapBounds.y + mapBounds.height / 2,
  );

  const cctvToggle = page.getByRole('button', { name: 'CCTV' });
  await expect(cctvToggle).toBeEnabled({ timeout: 30_000 });
  await cctvToggle.click();
  await expect(cctvToggle).toHaveAttribute('aria-pressed', 'true');

  const viewer = page.getByRole('dialog', { name: /Camera feed: Tsarigradsko Shose/ });
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.toast-notification')).toHaveCount(0);
  await expect(viewer.getByText('Tsarigradsko Shose (UAB)')).toBeVisible();
  await expect(viewer.getByText(/SOFIA · BULGARIA · SOURCE: UAB \/ KAMEPA/i)).toBeVisible();
  await expect(viewer.locator('.map-webcam-viewer-image')).toBeVisible();
  await expect(viewer.getByRole('link', { name: /RAW FEED/ })).toHaveAttribute('href', /cdn\.uab\.org/);
  await expect(viewer.getByRole('link', { name: /MAP TARGET/ })).toHaveAttribute('href', /42\.662,23\.376/);

  await viewer.getByRole('button', { name: 'Pin this camera' }).click();
  await expect(viewer.getByRole('button', { name: 'Pin this camera' })).toBeDisabled();
  await viewer.getByRole('button', { name: 'Toggle fullscreen camera' }).click();
  await expect(viewer).toHaveClass(/expanded/);
  await viewer.getByRole('button', { name: 'Close camera viewer' }).click();
  await expect(viewer).toBeHidden();
  await cctvToggle.click();
  await expect(cctvToggle).toHaveAttribute('aria-pressed', 'false');
  expect(pageErrors).toEqual([]);
});

test('opens the public Starbase camera from the Starbase map location', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem('worldmonitor-layers');
  });
  await page.route('https://i.ytimg.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#08131d"/><text x="480" y="270" text-anchor="middle" fill="#ffcc33" font-size="42">STARBASE LIVE</text></svg>',
    });
  });
  await page.route('https://www.youtube-nocookie.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Starbase live stream</title><body style="background:#000;color:#fc3">STARBASE LIVE STREAM</body>',
    });
  });

  await page.goto('/?lat=25.997&lon=-97.155&zoom=10');
  const mapContainer = page.locator('#mapContainer');
  await expect(mapContainer).toHaveClass(/(?:svg|deckgl)-mode/, { timeout: 30_000 });
  const bounds = await mapContainer.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const cctvToggle = page.getByRole('button', { name: 'CCTV' });
  await cctvToggle.click();
  const viewer = page.getByRole('dialog', { name: /Camera feed: Starbase Rover Cam/ });
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  await expect(viewer.getByText(/STARBASE, TEXAS · USA · SOURCE: LABPADRE SPACE/i)).toBeVisible();
  await viewer.getByRole('button', { name: 'Play live camera feed' }).click();
  await expect(viewer.locator('.map-webcam-viewer-iframe')).toBeVisible();
  await expect(viewer).toHaveClass(/streaming/);
  await expect(viewer.getByRole('link', { name: /RAW FEED/ })).toHaveAttribute('href', /youtube\.com\/live\/jbZZYZXB1ZY/);
});
