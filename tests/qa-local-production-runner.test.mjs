import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../scripts/qa-local-production.mjs', import.meta.url), 'utf8');

test('local production QA supports an assertion-only run with no screenshot directory', () => {
  assert.match(source, /captureScreenshots = process\.env\.WM_QA_SCREENSHOTS !== '0'/);
  assert.match(source, /if \(captureScreenshots\) mkdirSync\(screenshotDir/);
  assert.match(source, /async function capture[\s\S]*?if \(!captureScreenshots\) return false/);
});

test('browser scenes reuse the signed session verified by the API gate', () => {
  assert.match(source, /anonymousSessionExpiresAt > Date\.now\(\)/);
  assert.match(source, /context\.addCookies/);
  assert.match(source, /context\.route\(relativeUrl\('\/api\/wm-session'\)/);
  assert.match(source, /browserSessionRefreshesReused \+= 1/);
});

test('AOI QA survives its restore reload and explicitly selects the supported renderer', () => {
  const marker = source.indexOf("const initMarker = 'wm-qa-context-initialized-v1'");
  const aoiScene = source.indexOf("slug: 'red-sea-aoi'");
  const flatRenderer = source.indexOf("await selectRenderer(page, 'flat')", aoiScene);
  const aoiSeed = source.indexOf("localStorage.setItem('worldmonitor.aoi.shapes.v1'", aoiScene);
  const reload = source.indexOf("await page.reload({ waitUntil: 'domcontentloaded' })", aoiSeed);

  assert.ok(marker >= 0, 'storage reset must be guarded by a per-tab marker');
  assert.ok(aoiScene >= 0, 'AOI scene must exist');
  assert.ok(flatRenderer > aoiScene && flatRenderer < aoiSeed, 'AOI must switch to the 2D renderer before seeding');
  assert.ok(aoiSeed > flatRenderer && reload > aoiSeed, 'AOI fixture must be seeded before the restore reload');
});
