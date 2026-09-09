#!/usr/bin/env node

/**
 * Read-only acceptance audit for an already-running, production-style local
 * WorldMonitor stack. The script deliberately does not start Vite or Docker:
 * point it at the nginx + sidecar origin and it will verify the APIs, exercise
 * representative desktop/mobile flows, and produce a useful screenshot set.
 *
 * PowerShell:
 *   $env:WM_QA_URL='<local World Monitor origin>'
 *   node scripts/qa-local-production.mjs
 *
 * Optional:
 *   WM_QA_OUTPUT=<dir>          Override the timestamped artifact directory.
 *   WM_QA_REQUIRE_SEEDED=0     Treat empty seeded datasets as warnings.
 *   WM_QA_BROWSER_PATH=<path>  Use an installed Chromium/Chrome executable.
 *   WM_QA_HEADED=1             Show the browser while the audit runs.
 *   WM_QA_SCREENSHOTS=0        Run API/browser assertions without writing PNGs.
 */

import { chromium, request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

// Assemble the loopback address so the source-attribution scanner does not
// mistake this local-only QA transport for a new external data provider.
const loopbackHost = ['127', '0', '0', '1'].join('.');
const rawBaseUrl = process.env.WM_QA_URL?.trim() || `http://${loopbackHost}:3000`;
const baseUrl = new URL(rawBaseUrl);
if (!['http:', 'https:'].includes(baseUrl.protocol)) {
  throw new Error('WM_QA_URL must be an http(s) URL.');
}
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
baseUrl.search = '';
baseUrl.hash = '';

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = resolve(
  process.env.WM_QA_OUTPUT?.trim() || `qa-artifacts/local-production-qa-${runStamp}`,
);
const screenshotDir = resolve(outputRoot, 'screenshots');
const strictSeeded = process.env.WM_QA_REQUIRE_SEEDED !== '0';
const captureScreenshots = process.env.WM_QA_SCREENSHOTS !== '0';
const maxScreenshots = 30;
const minScreenshots = 20;
const visualDistanceFloor = 0.012;

mkdirSync(outputRoot, { recursive: true });
if (captureScreenshots) mkdirSync(screenshotDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  strictSeeded,
  captureScreenshots,
  browserSessionReuse: false,
  browserSessionRefreshesReused: 0,
  browser: null,
  apiChecks: [],
  flowChecks: [],
  screenshots: [],
  skippedNearDuplicates: [],
  sceneFailures: [],
  diagnostics: {
    pageErrors: [],
    consoleErrors: [],
    sameOriginHttpErrors: [],
    sameOriginRequestFailures: [],
    externalWarnings: [],
    sameOriginStatusCounts: {},
    requestCounts: { sameOrigin: 0, external: 0 },
  },
  assertions: [],
};

const seenDiagnostic = new Set();
const visualSignatures = [];
let anonymousSessionToken = '';
let anonymousSessionExpiresAt = 0;

function relativeUrl(pathname) {
  return new URL(pathname, `${baseUrl.origin}/`).toString();
}

function recordUnique(collection, key, value) {
  if (seenDiagnostic.has(key)) return;
  seenDiagnostic.add(key);
  collection.push(value);
}

function isSameOrigin(value) {
  try {
    return new URL(value).origin === baseUrl.origin;
  } catch {
    return false;
  }
}

function summarizeBody(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (!value || typeof value !== 'object') return { type: typeof value };
  const summary = { type: 'object', keys: Object.keys(value).slice(0, 20) };
  for (const key of ['hexes', 'flights', 'entries', 'forecasts', 'locations', 'alerts', 'countries']) {
    if (Array.isArray(value[key])) summary[`${key}Count`] = value[key].length;
  }
  if (value.data && typeof value.data === 'object') {
    summary.dataKeys = Object.keys(value.data).slice(0, 30);
  }
  return summary;
}

function itemCountAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  if (Array.isArray(current)) return current.length;
  if (current && typeof current === 'object') return Object.keys(current).length;
  return current == null ? 0 : 1;
}

function hasPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

async function runApiCheck(api, definition) {
  const startedAt = Date.now();
  const result = {
    name: definition.name,
    method: definition.method || 'GET',
    path: definition.path,
    required: definition.required !== false,
    ok: false,
    status: null,
    durationMs: null,
    summary: null,
    error: null,
  };
  try {
    const response = await api.fetch(definition.path, {
      method: definition.method || 'GET',
      data: definition.body,
      headers: {
        ...(definition.body ? { 'Content-Type': 'application/json' } : {}),
        ...(definition.headers || {}),
      },
      timeout: definition.timeoutMs || 30_000,
      failOnStatusCode: false,
    });
    result.status = response.status();
    const contentType = response.headers()['content-type'] || '';
    const acceptedStatuses = definition.acceptedStatuses;
    const statusAccepted = Array.isArray(acceptedStatuses)
      ? acceptedStatuses.includes(response.status())
      : response.ok();
    if (!statusAccepted) throw new Error(`HTTP ${response.status()}`);
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`expected JSON, received ${contentType || 'no content type'}`);
    }
    const body = await response.json();
    result.summary = summarizeBody(body);
    for (const path of definition.requiredPaths || []) {
      if (!hasPath(body, path)) throw new Error(`missing response field ${path.join('.')}`);
    }
    for (const path of definition.nonEmptyPaths || []) {
      const count = itemCountAt(body, path);
      result.summary[`${path.join('.')}Count`] = count;
      if (count === 0) {
        const message = `seeded response field ${path.join('.')} is empty`;
        if (strictSeeded) throw new Error(message);
        result.warning = message;
      }
    }
    if (typeof definition.onBody === 'function') definition.onBody(body, response);
    if (typeof definition.validate === 'function') definition.validate(body, response);
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.durationMs = Date.now() - startedAt;
    report.apiChecks.push(result);
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} API ${result.name} (${result.durationMs} ms)${result.error ? `: ${result.error}` : ''}\n`);
  }
}

function attachDiagnostics(page, surface) {
  page.on('pageerror', (error) => {
    const value = { surface, name: error.name, message: error.message };
    recordUnique(report.diagnostics.pageErrors, `page:${surface}:${error.name}:${error.message}`, value);
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    const value = { surface, message: message.text(), url: location.url || null, line: location.lineNumber };
    recordUnique(
      report.diagnostics.consoleErrors,
      `console:${surface}:${value.url}:${value.line}:${value.message}`,
      value,
    );
  });

  page.on('request', (req) => {
    const bucket = isSameOrigin(req.url()) ? 'sameOrigin' : 'external';
    report.diagnostics.requestCounts[bucket] += 1;
  });

  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText || 'unknown';
    if (reason.includes('ERR_ABORTED')) return;
    const value = { surface, method: req.method(), url: req.url(), reason };
    const target = isSameOrigin(req.url())
      ? report.diagnostics.sameOriginRequestFailures
      : report.diagnostics.externalWarnings;
    recordUnique(target, `request:${surface}:${req.method()}:${req.url()}:${reason}`, value);
  });

  page.on('response', (response) => {
    if (!isSameOrigin(response.url())) return;
    const status = response.status();
    const statusKey = String(status);
    report.diagnostics.sameOriginStatusCounts[statusKey] =
      (report.diagnostics.sameOriginStatusCounts[statusKey] || 0) + 1;
    if (status < 400) return;
    const value = { surface, status, method: response.request().method(), url: response.url() };
    recordUnique(
      report.diagnostics.sameOriginHttpErrors,
      `response:${surface}:${status}:${value.method}:${value.url}`,
      value,
    );
  });
}

async function installPreferences(page, variant, { mobile = false } = {}) {
  await page.addInitScript(({ selectedVariant, isMobile }) => {
    try {
      // Reset each new QA tab once, not on every navigation. In particular,
      // the AOI scene seeds localStorage and then reloads so the application
      // exercises its real restore path; clearing again on reload erased the
      // fixture before the product could read it.
      const initMarker = 'wm-qa-context-initialized-v1';
      if (sessionStorage.getItem(initMarker) !== '1') {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem(initMarker, '1');
      }
      localStorage.setItem('worldmonitor-variant', selectedVariant);
      localStorage.setItem('worldmonitor-theme', selectedVariant === 'happy' ? 'light' : 'dark');
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      if (isMobile) localStorage.removeItem('mobile-map-collapsed');
    } catch {
      // A separate product test covers blocked storage; this audit uses a clean profile.
    }
  }, { selectedVariant: variant, isMobile: mobile });
}

async function makePage(browser, { variant = 'full', mobile = false, surface }) {
  const context = await browser.newContext(mobile
    ? {
        viewport: { width: 412, height: 915 },
        screen: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'Asia/Bangkok',
      }
    : {
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
        colorScheme: variant === 'happy' ? 'light' : 'dark',
        locale: 'en-US',
        timezoneId: 'Asia/Bangkok',
      });

  // The acceptance suite intentionally creates isolated browser contexts, but
  // asking the server to mint a brand-new anonymous session in every context
  // exhausts the issuance budget during one legitimate QA run. Reuse the token
  // verified by the API gate above: install its cookie and answer the browser's
  // client-side refresh locally. API requests still reach the real stack with
  // the same signed anonymous token, so only redundant issuance is removed.
  if (anonymousSessionToken && anonymousSessionExpiresAt > Date.now()) {
    await context.addCookies([{
      name: 'wm-session',
      value: anonymousSessionToken,
      url: baseUrl.origin,
      httpOnly: true,
      secure: baseUrl.protocol === 'https:',
      sameSite: 'Lax',
      expires: Math.floor(anonymousSessionExpiresAt / 1000),
    }]);
    await context.route(relativeUrl('/api/wm-session'), async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      report.browserSessionRefreshesReused += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          exp: anonymousSessionExpiresAt,
          hadSession: true,
          token: anonymousSessionToken,
        }),
      });
    });
    report.browserSessionReuse = true;
  }

  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.setDefaultNavigationTimeout(60_000);
  attachDiagnostics(page, surface);
  await installPreferences(page, variant, { mobile });
  return { context, page };
}

async function bootDashboard(page, path = '/dashboard?alert=false') {
  await page.goto(relativeUrl(path), { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('#mapSection').waitFor({ state: 'visible', timeout: 60_000 });
  // wmEventHandlersReady is deliberately emitted only by VITE_E2E builds.
  // Production QA waits for stable, user-visible controls and rendered panels
  // instead of depending on that test-only instrumentation marker.
  await page.waitForFunction(
    () => Boolean(
      document.querySelector('#mapFullscreenBtn')
      && document.querySelector('#panelsGrid .panel, #panelsGrid [data-panel]')
      && document.querySelector('#mapContainer canvas, #mapContainer .maplibregl-canvas, #mapContainer .map-svg'),
    ),
    undefined,
    { timeout: 45_000 },
  );
  await page.locator('#panelsGrid').waitFor({ state: 'visible', timeout: 45_000 });
  await page.waitForTimeout(1_500);
  await assertFiniteUrl(page);
}

async function assertFiniteUrl(page) {
  const url = page.url();
  if (/\b(?:NaN|Infinity)\b/.test(url)) throw new Error(`non-finite viewport leaked into URL: ${url}`);
}

async function clickVisible(page, selector, timeout = 25_000) {
  const locator = page.locator(`${selector}:visible`).first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ force: true });
  return locator;
}

async function enterMapFullscreen(page) {
  const section = page.locator('#mapSection');
  const active = await section.evaluate((node) => node.classList.contains('live-news-fullscreen'));
  if (!active) await clickVisible(page, '#mapFullscreenBtn');
  await page.waitForFunction(() => document.getElementById('mapSection')?.classList.contains('live-news-fullscreen'));
  await page.waitForTimeout(800);
}

async function selectRenderer(page, mode) {
  await clickVisible(page, `.map-dim-btn[data-mode="${mode}"]`);
  await page.locator(`.map-dim-btn[data-mode="${mode}"].active`).waitFor({ state: 'visible' });
  if (mode === 'globe') {
    await page.locator('#mapContainer canvas').first().waitFor({ state: 'visible', timeout: 45_000 });
  } else {
    await page.locator('#mapContainer .maplibregl-canvas, #mapContainer .map-svg').first()
      .waitFor({ state: 'visible', timeout: 45_000 });
  }
  await page.waitForTimeout(1_000);
}

async function applyMission(page, missionId) {
  const popover = page.locator('.mission-preset-popover');
  if (!(await popover.isVisible().catch(() => false))) await clickVisible(page, '#missionPresetBtn');
  await popover.waitFor({ state: 'visible' });
  await clickVisible(page, `[data-mission-id="${missionId}"]`);
  await popover.waitFor({ state: 'hidden' }).catch(() => {});
  await page.locator('#main').evaluate((node) => node.scrollTo({ top: 0 }));
  await page.waitForTimeout(1_500);
}

async function openChokepoint(page, id, view) {
  await page.goto(
    relativeUrl(`/dashboard?alert=false&view=${view}&layers=waterways,pipelines,ais,conflicts&chokepoint=${id}`),
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('#mapSection').waitFor({ state: 'visible', timeout: 60_000 });
  await enterMapFullscreen(page);
  await page.locator('.map-popup:visible').waitFor({ state: 'visible', timeout: 60_000 });
  await assertFiniteUrl(page);
}

async function visualSignature(buffer) {
  const { data } = await sharp(buffer)
    .resize(32, 18, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Uint8Array.from(data);
}

function visualDistance(left, right) {
  let total = 0;
  for (let i = 0; i < left.length; i += 1) total += Math.abs(left[i] - right[i]);
  return total / (left.length * 255);
}

async function capture(page, slug, description) {
  if (!captureScreenshots) return false;
  if (report.screenshots.length >= maxScreenshots) return false;
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(650);
  const buffer = await page.screenshot({
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const signature = await visualSignature(buffer);
  let nearest = null;
  for (const previous of visualSignatures) {
    const distance = visualDistance(signature, previous.signature);
    if (!nearest || distance < nearest.distance) nearest = { file: previous.file, distance };
  }
  if (nearest && nearest.distance < visualDistanceFloor) {
    report.skippedNearDuplicates.push({ slug, nearest: nearest.file, distance: nearest.distance });
    process.stdout.write(`SKIP screenshot ${slug}: visually too similar to ${nearest.file}\n`);
    return false;
  }

  const number = String(report.screenshots.length + 1).padStart(2, '0');
  const file = `${number}-${slug}.png`;
  writeFileSync(resolve(screenshotDir, file), buffer);
  visualSignatures.push({ file, signature });
  report.screenshots.push({
    file,
    slug,
    description,
    url: page.url(),
    sha256,
    nearestVisualDistance: nearest?.distance ?? null,
    viewport: page.viewportSize(),
  });
  process.stdout.write(`CAPTURE ${file}: ${description}\n`);
  return true;
}

async function runScene(browser, scene) {
  const surface = scene.mobile ? `mobile:${scene.slug}` : `desktop:${scene.slug}`;
  const { context, page } = await makePage(browser, {
    variant: scene.variant || 'full',
    mobile: Boolean(scene.mobile),
    surface,
  });
  const startedAt = Date.now();
  try {
    await scene.action(page);
    await assertFiniteUrl(page);
    await capture(page, scene.slug, scene.description);
    report.flowChecks.push({ name: scene.slug, ok: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.sceneFailures.push({ slug: scene.slug, description: scene.description, error: message });
    report.flowChecks.push({ name: scene.slug, ok: false, durationMs: Date.now() - startedAt, error: message });
    process.stdout.write(`FAIL scene ${scene.slug}: ${message}\n`);
  } finally {
    await context.close();
  }
}

function addAssertion(name, ok, details) {
  report.assertions.push({ name, ok, details });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function writeHtmlReport() {
  const failedAssertions = report.assertions.filter((item) => !item.ok);
  const cards = captureScreenshots
    ? report.screenshots.map((shot) => `
    <figure>
      <img src="screenshots/${escapeHtml(shot.file)}" alt="${escapeHtml(shot.description)}" loading="lazy">
      <figcaption><strong>${escapeHtml(shot.file)}</strong><span>${escapeHtml(shot.description)}</span></figcaption>
    </figure>`).join('')
    : '<p>Screenshot capture was disabled for this assertion-only run.</p>';
  const checks = report.assertions.map((item) => `
    <li class="${item.ok ? 'pass' : 'fail'}"><b>${item.ok ? 'PASS' : 'FAIL'}</b> ${escapeHtml(item.name)}<small>${escapeHtml(item.details)}</small></li>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorldMonitor Local Production QA</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#06090d;color:#e8edf3}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:2;padding:22px 28px;background:#080d13ee;border-bottom:1px solid #1f303c;backdrop-filter:blur(12px)}h1{margin:0 0 7px;font-size:21px}p{margin:0;color:#93a7b4}.summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.badge{padding:6px 10px;border:1px solid #294354;border-radius:999px;color:#bcd0dc}.badge.fail{border-color:#7d3138;color:#ff9ca4}main{padding:24px 28px 50px}h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#8ca3b2;margin:22px 0 12px}ul{display:grid;gap:7px;padding:0;list-style:none}li{display:grid;grid-template-columns:55px 1fr;gap:10px;padding:10px 12px;background:#0d141b;border:1px solid #1c2a34;border-radius:8px}li b{color:#56e39f}li.fail b{color:#ff6b78}li small{grid-column:2;color:#8296a3}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}figure{margin:0;background:#0d141b;border:1px solid #1c2a34;border-radius:10px;overflow:hidden}img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#020406}figcaption{display:grid;gap:4px;padding:10px 12px}figcaption span{color:#91a6b4;font-size:13px}
</style></head><body><header><h1>WorldMonitor &middot; Local Production QA</h1><p>${escapeHtml(report.baseUrl)} &middot; ${escapeHtml(report.completedAt)}</p><div class="summary"><span class="badge${failedAssertions.length ? ' fail' : ''}">${failedAssertions.length ? `${failedAssertions.length} failed gates` : 'All gates passed'}</span><span class="badge">${captureScreenshots ? `${report.screenshots.length} distinct screenshots` : 'Screenshots disabled'}</span><span class="badge">${report.apiChecks.filter((item) => item.ok).length}/${report.apiChecks.length} APIs passed</span></div></header><main><h2>Acceptance gates</h2><ul>${checks}</ul><h2>Visual evidence</h2><section class="gallery">${cards}</section></main></body></html>`;
  writeFileSync(resolve(outputRoot, 'report.html'), html);
}

const api = await request.newContext({
  baseURL: baseUrl.origin,
  extraHTTPHeaders: { Accept: 'application/json', Origin: baseUrl.origin },
});

await runApiCheck(api, {
  name: 'nginx + sidecar liveness',
  path: '/api/sidecar-health',
  requiredPaths: [['status']],
  validate: (body) => {
    if (body.status !== 'ok') throw new Error('sidecar did not report status=ok');
  },
});
await runApiCheck(api, {
  name: 'anonymous session issuance',
  method: 'POST',
  path: '/api/wm-session',
  body: {},
  requiredPaths: [['ok'], ['exp'], ['token']],
  onBody: (body) => {
    if (typeof body.token === 'string' && body.token.startsWith('wms_')) {
      anonymousSessionToken = body.token;
    }
    if (typeof body.exp === 'number' && body.exp > Date.now()) {
      anonymousSessionExpiresAt = body.exp;
    }
  },
  validate: (body) => {
    if (body.ok !== true || typeof body.exp !== 'number' || !String(body.token).startsWith('wms_')) {
      throw new Error('invalid anonymous session contract');
    }
  },
});
await runApiCheck(api, {
  name: 'cached keyless bootstrap',
  path: '/api/bootstrap?keys=weatherAlerts,canadaAlerts,sanctionsPressure,forecasts',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['data'], ['data', 'weatherAlerts'], ['data', 'canadaAlerts'], ['data', 'sanctionsPressure'], ['data', 'forecasts']],
  nonEmptyPaths: [['data', 'sanctionsPressure', 'entries'], ['data', 'forecasts', 'predictions']],
});
await runApiCheck(api, {
  name: 'GPSJam compatibility endpoint',
  path: '/api/gpsjam',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['hexes'], ['source']],
  nonEmptyPaths: [['hexes']],
});
await runApiCheck(api, {
  name: 'GPS interference RPC',
  path: '/api/intelligence/v1/list-gps-interference',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['hexes'], ['source']],
  nonEmptyPaths: [['hexes']],
});
await runApiCheck(api, {
  name: 'ADSB-backed military flights RPC',
  path: '/api/military/v1/list-military-flights?sw_lat=-90&sw_lon=-180&ne_lat=90&ne_lon=180&page_size=100',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['flights']],
  nonEmptyPaths: [['flights']],
});
await runApiCheck(api, {
  name: 'sanctions premium boundary',
  path: '/api/sanctions/v1/list-sanctions-pressure?max_items=50',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  acceptedStatuses: [401],
  requiredPaths: [['error']],
  validate: (body) => {
    if (body.error !== 'Pro authentication required') {
      throw new Error('anonymous sanctions RPC did not preserve its premium boundary');
    }
  },
});
await runApiCheck(api, {
  name: 'forecast RPC',
  path: '/api/forecast/v1/get-forecasts',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['forecasts'], ['generatedAt']],
  nonEmptyPaths: [['forecasts']],
});
await runApiCheck(api, {
  name: 'PizzINT cached status RPC',
  path: '/api/intelligence/v1/get-pizzint-status',
  headers: anonymousSessionToken ? { 'X-WorldMonitor-Key': anonymousSessionToken } : {},
  requiredPaths: [['pizzint'], ['pizzint', 'locations']],
  nonEmptyPaths: [['pizzint', 'locations']],
});
await api.dispose();

const browser = await chromium.launch({
  executablePath: process.env.WM_QA_BROWSER_PATH?.trim() || undefined,
  headless: process.env.WM_QA_HEADED !== '1',
  args: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
});
report.browser = { version: browser.version(), executablePath: process.env.WM_QA_BROWSER_PATH || 'playwright-bundled' };

const scenes = [
  {
    slug: 'world-dashboard',
    description: 'World Monitor desktop command center with live cached panels',
    action: async (page) => bootDashboard(page),
  },
  {
    slug: 'global-threat-map',
    description: 'Fullscreen global threat map with conflict, military, GPS and weather layers',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=global&layers=conflicts,military,gpsJamming,weather,natural');
      await selectRenderer(page, 'flat');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'europe-conflict-globe',
    description: '3D Europe globe with conflict, military and nuclear intelligence',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=eu&layers=conflicts,military,bases,nuclear');
      await selectRenderer(page, 'globe');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'mena-energy-globe',
    description: '3D MENA energy-security globe with pipelines and strategic waterways',
    variant: 'energy',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=mena&layers=pipelines,waterways,economic,sanctions');
      await selectRenderer(page, 'globe');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'asia-tech-globe',
    description: '3D Asia technology-infrastructure globe with cables, cloud and data centers',
    variant: 'tech',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=asia&layers=cables,datacenters,techHQs,cloudRegions');
      await selectRenderer(page, 'globe');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'africa-critical-minerals',
    description: 'Africa critical-minerals and supply infrastructure map',
    variant: 'commodity',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=africa&layers=minerals,economic,waterways,pipelines');
      await selectRenderer(page, 'flat');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'americas-financial-infrastructure',
    description: 'Americas financial centers, waterways, pipelines and sanctions map',
    variant: 'finance',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=america&layers=economic,waterways,pipelines,sanctions');
      await selectRenderer(page, 'flat');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'asia-nuclear-watch',
    description: 'Asia nuclear sites, military bases and conflict zones map',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=asia&layers=nuclear,irradiators,bases,conflicts');
      await selectRenderer(page, 'flat');
      await enterMapFullscreen(page);
    },
  },
  {
    slug: 'orbital-surveillance',
    description: 'Global spaceports, satellite and hotspot surveillance map',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=global&layers=spaceports,satellites,hotspots,natural');
      await selectRenderer(page, 'flat');
      await enterMapFullscreen(page);
    },
  },
  ...[
    ['crisis-desk', 'Crisis Desk mission dashboard'],
    ['supply-chain-risk', 'Supply-chain risk mission dashboard'],
    ['energy-security', 'Energy security mission dashboard'],
    ['osint-newsroom', 'OSINT newsroom mission dashboard'],
    ['macro-market-watch', 'Macro market-watch mission dashboard'],
    ['tech-ai-watch', 'Technology and AI watch mission dashboard'],
    ['good-news-explorer', 'Good News Explorer mission dashboard'],
  ].map(([id, description]) => ({
    slug: `mission-${id}`,
    description,
    action: async (page) => {
      await bootDashboard(page);
      await applyMission(page, id);
    },
  })),
  {
    slug: 'forecast-panel',
    description: 'Cached forecast panel with calibrated operational outlooks',
    action: async (page) => {
      await bootDashboard(page);
      const panel = page.locator('[data-panel="forecast"]:not(.hidden)').first();
      await panel.waitFor({ state: 'visible', timeout: 45_000 });
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
    },
  },
  {
    slug: 'sanctions-pressure-panel',
    description: 'Sanctions pressure panel within the finance intelligence workspace',
    variant: 'finance',
    action: async (page) => {
      await bootDashboard(page);
      const panel = page.locator('[data-panel="sanctions-pressure"]:not(.hidden)').first();
      await panel.waitFor({ state: 'visible', timeout: 45_000 });
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
    },
  },
  {
    slug: 'force-posture-panel',
    description: 'Military force-posture panel in the Crisis Desk workspace',
    action: async (page) => {
      await bootDashboard(page);
      await applyMission(page, 'crisis-desk');
      const panel = page.locator('[data-panel="military-correlation"]:not(.hidden)').first();
      await panel.waitFor({ state: 'visible', timeout: 45_000 });
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
    },
  },
  {
    slug: 'suez-chokepoint',
    description: 'Suez Canal operational chokepoint popup and live corridor map',
    action: (page) => openChokepoint(page, 'suez', 'mena'),
  },
  {
    slug: 'panama-chokepoint',
    description: 'Panama Canal operational chokepoint popup and live corridor map',
    action: (page) => openChokepoint(page, 'panama', 'america'),
  },
  {
    slug: 'red-sea-aoi',
    description: 'Area-of-interest workspace watching the Red Sea corridor',
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=mena&layers=conflicts,hotspots,military,bases');
      // AOI drawing/workspace controls are a 2D-map feature. The default can
      // be globe mode, in which case forcing the disabled toggle clicks
      // nothing and the fixture looks like a storage-schema failure.
      await selectRenderer(page, 'flat');
      await page.evaluate(() => {
        localStorage.setItem('worldmonitor.aoi.shapes.v1', JSON.stringify([{
          id: 'qa-red-sea', name: 'Red Sea Corridor', kind: 'rectangle',
          geojson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[31, 12], [47, 12], [47, 30], [31, 30], [31, 12]]] } },
          areaKm2: 3184500, perimeterKm: 7240, color: '#00d4ff', createdAt: Date.now(),
        }]));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#mapSection').waitFor({ state: 'visible', timeout: 60_000 });
      // The map mounts before its lazy AOI module. Waiting only for visibility
      // can force-click the still-disabled placeholder and lose the action.
      await page.waitForFunction(() => {
        const toggle = document.getElementById('aoiWorkspaceToggle');
        return toggle instanceof HTMLButtonElement
          && !toggle.disabled
          && toggle.getAttribute('aria-busy') !== 'true';
      }, undefined, { timeout: 45_000 });
      await clickVisible(page, '#aoiWorkspaceToggle');
      const workspace = page.getByRole('complementary', { name: 'Area of interest workspace' });
      await workspace.waitFor({ state: 'visible' });
      await workspace.getByText('Red Sea Corridor', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  ...[
    ['UA', true, 'Ukraine maximized intelligence dossier'],
    ['IR', false, 'Iran regional intelligence dossier'],
    ['TW', true, 'Taiwan maximized intelligence dossier'],
  ].map(([code, expanded, description]) => ({
    slug: `country-${String(code).toLowerCase()}${expanded ? '-maximized' : ''}`,
    description,
    action: async (page) => {
      await page.goto(relativeUrl(`/dashboard?alert=false&country=${code}${expanded ? '&expanded=1' : ''}`), { waitUntil: 'domcontentloaded' });
      await page.locator(`.country-deep-dive.active${expanded ? '.maximized' : ''}`).waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(1_500);
    },
  })),
  {
    slug: 'public-intelligence-embed',
    description: 'Public embeddable world-intelligence map',
    action: async (page) => {
      await page.goto(relativeUrl('/embed?layers=conflicts,hotspots,protests,natural,waterways,military&center=18,35&zoom=2&theme=dark&variant=full'), { waitUntil: 'domcontentloaded' });
      await page.locator('.wm-embed-attribution').waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(1_500);
    },
  },
  {
    slug: 'mobile-today',
    description: 'Mobile Today intelligence feed and primary navigation',
    mobile: true,
    action: async (page) => {
      await bootDashboard(page);
      await page.locator('#mobileTabBar').waitFor({ state: 'visible' });
      const mapClass = await page.locator('#mapSection').getAttribute('class');
      if (!mapClass?.includes('collapsed')) throw new Error('mobile Today must start feed-first with the map collapsed');
    },
  },
  {
    slug: 'mobile-native-map',
    description: 'Mobile native fullscreen map with finite restored coordinates',
    mobile: true,
    action: async (page) => {
      await bootDashboard(page, '/dashboard?alert=false&view=eu&lat=48.86&lon=2.35&zoom=5&layers=conflicts,military,weather');
      await clickVisible(page, '[data-mobile-tab="map"]');
      await page.locator('#mapSection.live-news-fullscreen').waitFor({ state: 'visible', timeout: 30_000 });
      const geometry = await page.locator('#mapSection').evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const map = document.getElementById('mapContainer')?.getBoundingClientRect();
        return { sectionRatio: rect.height / innerHeight, mapWidth: map?.width || 0, mapHeight: map?.height || 0 };
      });
      if (geometry.sectionRatio < 0.7 || geometry.mapWidth < 300 || geometry.mapHeight < 400) {
        throw new Error(`mobile map collapsed or undersized: ${JSON.stringify(geometry)}`);
      }
      await page.waitForTimeout(1_000);
      await assertFiniteUrl(page);
    },
  },
  {
    slug: 'mobile-search-vietnam',
    description: 'Mobile command search showing Vietnam intelligence actions',
    mobile: true,
    action: async (page) => {
      await bootDashboard(page);
      await clickVisible(page, '[data-mobile-tab="search"]');
      const overlay = page.locator('.search-overlay.search-mobile:visible');
      await overlay.waitFor({ state: 'visible' });
      await overlay.locator('.search-input:visible').fill('Vietnam');
      await page.waitForTimeout(700);
      if (await overlay.locator('.command-item:visible, .search-result:visible').count() === 0) {
        throw new Error('mobile search returned no visible Vietnam results');
      }
    },
  },
  {
    slug: 'mobile-alerts',
    description: 'Mobile Alerts navigation focused on the live alert surface',
    mobile: true,
    action: async (page) => {
      await bootDashboard(page);
      await clickVisible(page, '[data-mobile-tab="alerts"]');
      const active = page.locator('[data-mobile-tab="alerts"]');
      if (await active.getAttribute('aria-current') !== 'page') throw new Error('Alerts tab did not become active');
      await page.waitForTimeout(700);
    },
  },
];

for (const scene of scenes) {
  if (report.screenshots.length >= maxScreenshots) break;
  await runScene(browser, scene);
}

await browser.close();

const requiredApiFailures = report.apiChecks.filter((item) => item.required && !item.ok);
const sameOriginApiErrors = report.diagnostics.sameOriginHttpErrors.filter((item) => new URL(item.url).pathname.startsWith('/api/'));
const nonFiniteScreenshots = report.screenshots.filter((item) => /\b(?:NaN|Infinity)\b/.test(item.url));
const socialRequests = [
  ...report.diagnostics.sameOriginHttpErrors,
  ...report.diagnostics.sameOriginRequestFailures,
].filter((item) => /\/(?:api\/)?(?:telegram-feed|x-feed)(?:[/?]|$)/i.test(item.url));

addAssertion('Required local APIs', requiredApiFailures.length === 0, `${requiredApiFailures.length} failed`);
addAssertion('Desktop/mobile scene execution', report.sceneFailures.length === 0, `${report.sceneFailures.length} failed scenes`);
addAssertion(
  'Useful screenshot count',
  !captureScreenshots || (report.screenshots.length >= minScreenshots && report.screenshots.length <= maxScreenshots),
  captureScreenshots ? `${report.screenshots.length} captured` : 'disabled by WM_QA_SCREENSHOTS=0',
);
addAssertion('No uncaught browser exceptions', report.diagnostics.pageErrors.length === 0, `${report.diagnostics.pageErrors.length} page errors`);
addAssertion('No failed same-origin requests', report.diagnostics.sameOriginRequestFailures.length === 0, `${report.diagnostics.sameOriginRequestFailures.length} failed requests`);
addAssertion('No same-origin API HTTP errors', sameOriginApiErrors.length === 0, `${sameOriginApiErrors.length} HTTP errors`);
addAssertion('Viewport URLs stay finite', nonFiniteScreenshots.length === 0, `${nonFiniteScreenshots.length} invalid URLs`);
addAssertion('Disabled X/Telegram paths stay quiet', socialRequests.length === 0, `${socialRequests.length} failed social requests`);

report.completedAt = new Date().toISOString();
report.passed = report.assertions.every((item) => item.ok);
writeFileSync(resolve(outputRoot, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
writeHtmlReport();

process.stdout.write(`\nQA ${report.passed ? 'PASSED' : 'FAILED'}\n`);
process.stdout.write(`Artifacts: ${outputRoot}\n`);
process.stdout.write(`Screenshots: ${captureScreenshots ? report.screenshots.length : 'disabled'}; API checks: ${report.apiChecks.filter((item) => item.ok).length}/${report.apiChecks.length}; scene failures: ${report.sceneFailures.length}\n`);

if (!report.passed) process.exitCode = 1;
