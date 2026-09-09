#!/usr/bin/env node

/**
 * Low-load scheduler for the self-hosted Docker stack.
 *
 * This intentionally runs a small, curated set of public-data seeders. Jobs
 * execute one at a time and each next run is measured from completion, so a
 * slow or unavailable upstream cannot create a catch-up storm. Weather and
 * PizzINT are not listed here because the AIS relay already refreshes them.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEFAULT_STARTUP_DELAY_MS = 10_000;
const DEFAULT_BETWEEN_JOBS_MS = 2_000;
const GPSJAM_OUTPUT_PATH = '/tmp/worldmonitor/gpsjam-latest.json';

export const LOCAL_SEED_JOBS = Object.freeze([
  Object.freeze({
    id: 'military-flights',
    script: 'seed-military-flights.mjs',
    intervalMs: 5 * MINUTE,
    timeoutMs: 2 * MINUTE,
  }),
  Object.freeze({
    id: 'canada-alerts-alberta',
    script: 'seed-alberta-emergency-alert.mjs',
    intervalMs: 15 * MINUTE,
    timeoutMs: 75_000,
  }),
  Object.freeze({
    id: 'canada-alerts-bc',
    script: 'seed-bc-emergency-info.mjs',
    intervalMs: 15 * MINUTE,
    timeoutMs: 75_000,
  }),
  Object.freeze({
    id: 'canada-alerts-saskatchewan',
    script: 'seed-saskalert.mjs',
    intervalMs: 15 * MINUTE,
    timeoutMs: 75_000,
  }),
  Object.freeze({
    id: 'gpsjam',
    script: 'fetch-gpsjam.mjs',
    args: Object.freeze(['--output', GPSJAM_OUTPUT_PATH]),
    intervalMs: DAY,
    timeoutMs: 2 * MINUTE,
  }),
  Object.freeze({
    id: 'portwatch',
    script: 'seed-bundle-portwatch.mjs',
    intervalMs: 6 * HOUR,
    timeoutMs: 10 * MINUTE,
  }),
  Object.freeze({
    id: 'hormuz-tracker',
    script: 'seed-hormuz.mjs',
    intervalMs: DAY,
    timeoutMs: 5 * MINUTE,
  }),
  Object.freeze({
    id: 'sanctions',
    script: 'seed-sanctions-pressure.mjs',
    intervalMs: 6 * HOUR,
    timeoutMs: 10 * MINUTE,
  }),
  Object.freeze({
    id: 'forecasts',
    script: 'seed-forecasts.mjs',
    intervalMs: HOUR,
    timeoutMs: 15 * MINUTE,
  }),
  Object.freeze({
    id: 'earthquakes',
    script: 'seed-earthquakes.mjs',
    intervalMs: 5 * MINUTE,
    timeoutMs: MINUTE,
    optionalEnv: 'LOCAL_SEED_EARTHQUAKES_ENABLED',
  }),
]);

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function boundedNonNegativeInteger(value, fallback, max = HOUR) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function createLocalSeedPlan(env = process.env, nowMs = Date.now()) {
  const startupDelayMs = boundedNonNegativeInteger(
    env.LOCAL_SEED_STARTUP_DELAY_MS,
    DEFAULT_STARTUP_DELAY_MS,
  );

  return LOCAL_SEED_JOBS
    .filter((job) => !job.optionalEnv || isEnabled(env[job.optionalEnv]))
    .map((job) => ({ ...job, args: [...(job.args || [])], nextRunAt: nowMs + startupDelayMs }));
}

/**
 * Build the environment inherited by every seeder without printing it.
 * Docker Compose supplies REDIS_TOKEN; seeders use the Upstash-compatible
 * variable name, so map the token exactly once at this process boundary.
 */
export function createSeederEnv(env = process.env) {
  const redisUrl = String(env.UPSTASH_REDIS_REST_URL || '').trim();
  const dockerToken = String(env.REDIS_TOKEN || '').trim();
  const upstashToken = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();

  if (!redisUrl) {
    throw new Error('UPSTASH_REDIS_REST_URL is required');
  }
  if (!dockerToken && !upstashToken) {
    throw new Error('REDIS_TOKEN or UPSTASH_REDIS_REST_TOKEN is required');
  }
  if (dockerToken && upstashToken && dockerToken !== upstashToken) {
    throw new Error('REDIS_TOKEN and UPSTASH_REDIS_REST_TOKEN must match when both are set');
  }

  return {
    ...env,
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: upstashToken || dockerToken,
    UPSTASH_ALLOW_INSECURE_HTTP: env.UPSTASH_ALLOW_INSECURE_HTTP || 'true',
    // Forecast has its own hourly slot. Do not let the five-minute military
    // seed spawn a second forecast process outside this scheduler.
    CHAIN_FORECAST_SEED_ON_MILITARY: '0',
    // adsb.lol is the licensed/keyless primary. Non-commercial gap-fill stays
    // opt-in and OpenSky is deliberately absent from the seeder waterfall.
    WM_ENABLE_NONCOMMERCIAL_ADSB_GAP_FILL: '0',
  };
}

export function nextRunAfterCompletion(job, completedAtMs) {
  return completedAtMs + job.intervalMs;
}

function wait(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function runSeederJob(job, {
  env,
  signal,
  spawnFn = spawn,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const scriptPath = join(SCRIPT_DIR, job.script);
  const args = [scriptPath, ...(job.args || [])];

  console.log(`[local-seeds] ${job.id}: starting`);

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const child = spawnFn(process.execPath, args, {
      cwd: join(SCRIPT_DIR, '..'),
      env,
      stdio: 'inherit',
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', stopChild);
      resolve({ ...result, durationMs: Math.max(0, now() - startedAt) });
    };

    const stopChild = () => {
      if (!settled) child.kill('SIGTERM');
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(`[local-seeds] ${job.id}: timed out after ${job.timeoutMs}ms`);
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKillTimer.unref?.();
    }, job.timeoutMs);
    timeoutTimer.unref?.();

    signal?.addEventListener('abort', stopChild, { once: true });
    child.once('error', (error) => finish({ ok: false, error }));
    child.once('exit', (code, exitSignal) => finish({
      ok: !timedOut && code === 0,
      code,
      signal: exitSignal,
      timedOut,
    }));
  });
}

export async function runLocalSeedScheduler({
  env = process.env,
  signal,
  now = Date.now,
  runJob = runSeederJob,
} = {}) {
  const childEnv = createSeederEnv(env);
  const jobs = createLocalSeedPlan(env, now());
  const betweenJobsMs = boundedNonNegativeInteger(
    env.LOCAL_SEED_BETWEEN_JOBS_MS,
    DEFAULT_BETWEEN_JOBS_MS,
    60_000,
  );

  if (jobs.some((job) => job.id === 'gpsjam')) {
    mkdirSync(dirname(GPSJAM_OUTPUT_PATH), { recursive: true });
  }

  console.log(`[local-seeds] scheduler ready (${jobs.length} jobs, sequential execution)`);

  while (!signal?.aborted) {
    jobs.sort((a, b) => a.nextRunAt - b.nextRunAt);
    const job = jobs[0];
    await wait(Math.max(0, job.nextRunAt - now()), signal);
    if (signal?.aborted) break;

    const result = await runJob(job, { env: childEnv, signal, now });
    const completedAt = now();
    job.nextRunAt = nextRunAfterCompletion(job, completedAt);

    if (result.ok) {
      console.log(`[local-seeds] ${job.id}: completed in ${result.durationMs}ms`);
    } else {
      const reason = result.timedOut
        ? 'timeout'
        : (result.error?.message || `exit ${result.code ?? result.signal ?? 'unknown'}`);
      console.error(`[local-seeds] ${job.id}: failed (${reason}); last-good cache preserved by seeder`);
    }

    await wait(betweenJobsMs, signal);
  }

  console.log('[local-seeds] scheduler stopped');
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await runLocalSeedScheduler({ signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`[local-seeds] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
