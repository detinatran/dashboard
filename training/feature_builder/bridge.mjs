/**
 * Node bridge between the Python training pipeline and the production feature
 * builder.
 *
 * The training set MUST be built by the same code that runs in production.
 * This reads one JSON job on stdin and returns the full feature matrix on
 * stdout, so the cost is one process for the whole dataset.
 */

import { buildFeatures, FEATURE_NAMES, FEATURE_VERSION } from '../../scripts/shared/coastal-features.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

const job = JSON.parse(await readStdin());
const levels = job.levels;
const weather = job.weather || [];
const bases = job.bases;

// Index by timestamp so each base time slices its own window without rescanning.
const sortedLevels = [...levels].sort((a, b) => a.ts - b.ts);
const sortedWeather = [...weather].sort((a, b) => a.ts - b.ts);

const HIST_MS = 24 * 3_600_000;
const X = [];
const baseTs = [];
const skipped = {};

let lo = 0;
let wlo = 0;
for (const t of bases) {
  const from = t - HIST_MS;
  while (lo < sortedLevels.length && sortedLevels[lo].ts < from) lo++;
  let hi = lo;
  while (hi < sortedLevels.length && sortedLevels[hi].ts <= t) hi++;
  const window = sortedLevels.slice(lo, hi);

  while (wlo < sortedWeather.length && sortedWeather[wlo].ts < from) wlo++;
  let whi = wlo;
  while (whi < sortedWeather.length && sortedWeather[whi].ts <= t) whi++;
  const wWindow = sortedWeather.slice(wlo, whi);

  const r = buildFeatures(window, t, wWindow);
  if (r.error) {
    skipped[r.error] = (skipped[r.error] || 0) + 1;
    continue;
  }
  X.push(Array.from(r.features));
  baseTs.push(t);
}

process.stdout.write(JSON.stringify({
  X, baseTs, skipped,
  featureNames: FEATURE_NAMES,
  featureVersion: FEATURE_VERSION,
}));
