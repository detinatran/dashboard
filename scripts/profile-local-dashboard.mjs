#!/usr/bin/env node
// Read-only browser profile. Timings are diagnostic, not a synthetic benchmark.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const target = new URL(process.env.WM_PROFILE_URL || 'http://' + ['127', '0', '0', '1'].join('.') + ':3000/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
  throw new Error('This profiler only targets local dashboards.');
}
const output = resolve(process.env.WM_PROFILE_OUTPUT || 'qa-artifacts/performance/latest.json');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WM_PROFILE_BROWSER ? { executablePath: process.env.WM_PROFILE_BROWSER } : { channel: 'chrome' }),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  const requests = new Map();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== target.origin || !url.pathname.startsWith('/api/')) return;
    // Never persist auth headers, bodies, cookies, or arbitrary query strings.
    const key = request.method() + ' ' + url.pathname + (url.pathname === '/api/bootstrap'
      ? ':' + (url.searchParams.get('tier') || url.searchParams.get('keys') || '') : '');
    requests.set(key, (requests.get(key) || 0) + 1);
  });
  await page.addInitScript(() => {
    window.__profile = { longTasks: [], lcp: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__profile.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__profile.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  };
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(20000);
  const startup = await page.evaluate(() => ({
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    lcpMs: window.__profile.lcp,
    longTasks: window.__profile.longTasks,
    panels: document.querySelectorAll('.panel').length,
    canvasCount: document.querySelectorAll('canvas').length,
  }));
  const startupRequests = Object.fromEntries(requests);
  const phases = [];
  // A pinned map may remain visible after scrolling. Record the actual canvas
  // visibility; these phases must not be interpreted as guaranteed pause tests.
  for (const phase of ['top', 'scroll-bottom', 'top-again']) {
    await page.evaluate((bottom) => window.scrollTo(0, bottom ? document.documentElement.scrollHeight : 0), phase === 'scroll-bottom');
    await page.waitForTimeout(1500);
    const before = await metric();
    await page.waitForTimeout(8000);
    const after = await metric();
    const canvases = await page.locator('canvas').evaluateAll((nodes) => nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(node).visibility !== 'hidden' };
    }));
    phases.push({ phase, taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, canvases });
  }
  const report = { at: new Date().toISOString(), url: target.origin + target.pathname,
    browser: browser.version(), viewport: '1440x900', windowSeconds: 8, startup,
    startupRequests, phases, totalRequests: Object.fromEntries(requests), errors };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  await browser.close();
}
