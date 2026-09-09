import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_SEED_JOBS,
  createLocalSeedPlan,
  createSeederEnv,
  nextRunAfterCompletion,
  runLocalSeedScheduler,
} from '../scripts/local-seed-scheduler.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('low-load local seed scheduler', () => {
  it('pins the curated jobs and cadences without duplicating relay-owned feeds', () => {
    const jobs = Object.fromEntries(LOCAL_SEED_JOBS.map((job) => [job.id, job]));

    assert.equal(jobs['military-flights'].intervalMs, 5 * MINUTE);
    assert.equal(jobs['canada-alerts-alberta'].intervalMs, 15 * MINUTE);
    assert.equal(jobs['canada-alerts-bc'].intervalMs, 15 * MINUTE);
    assert.equal(jobs['canada-alerts-saskatchewan'].intervalMs, 15 * MINUTE);
    assert.equal(jobs.sanctions.intervalMs, 6 * HOUR);
    assert.equal(jobs.forecasts.intervalMs, HOUR);
    assert.equal(jobs.gpsjam.intervalMs, DAY);
    assert.equal(jobs['chokepoint-baselines'].script, 'seed-chokepoint-baselines.mjs');
    assert.equal(jobs['chokepoint-baselines'].intervalMs, 7 * DAY);
    assert.ok(LOCAL_SEED_JOBS.findIndex((job) => job.id === 'chokepoint-baselines')
      < LOCAL_SEED_JOBS.findIndex((job) => job.id === 'portwatch'));
    assert.equal(jobs.portwatch.script, 'seed-bundle-portwatch.mjs');
    assert.equal(jobs.portwatch.intervalMs, 6 * HOUR);
    assert.equal(jobs.portwatch.timeoutMs, 10 * MINUTE);
    assert.equal(jobs['hormuz-tracker'].script, 'seed-hormuz.mjs');
    assert.equal(jobs['hormuz-tracker'].intervalMs, DAY);
    assert.equal(jobs['hormuz-tracker'].timeoutMs, 5 * MINUTE);
    assert.equal(jobs.earthquakes.intervalMs, 5 * MINUTE);
    assert.deepEqual(jobs.gpsjam.args, ['--output', '/tmp/worldmonitor/gpsjam-latest.json']);
    assert.equal(jobs.earthquakes.optionalEnv, 'LOCAL_SEED_EARTHQUAKES_ENABLED');

    const scripts = LOCAL_SEED_JOBS.map((job) => job.script);
    assert.equal(scripts.some((script) => /weather|pizzint/i.test(script)), false);
  });

  it('keeps earthquakes opt-in and applies one common startup deadline', () => {
    const now = 1_000_000;
    const base = createLocalSeedPlan({ LOCAL_SEED_STARTUP_DELAY_MS: '2500' }, now);
    assert.equal(base.some((job) => job.id === 'earthquakes'), false);
    assert.ok(base.every((job) => job.nextRunAt === now + 2_500));

    const enabled = createLocalSeedPlan({
      LOCAL_SEED_STARTUP_DELAY_MS: '2500',
      LOCAL_SEED_EARTHQUAKES_ENABLED: 'true',
    }, now);
    assert.equal(enabled.some((job) => job.id === 'earthquakes'), true);
  });

  it('schedules from completion instead of catching up from a stale deadline', () => {
    const job = { intervalMs: 5 * MINUTE, nextRunAt: 100 };
    assert.equal(nextRunAfterCompletion(job, 2_000_000), 2_000_000 + 5 * MINUTE);
  });

  it('never overlaps child seeders even when every initial job is due', async () => {
    const controller = new AbortController();
    const started = [];
    let active = 0;
    let maxActive = 0;

    await runLocalSeedScheduler({
      env: {
        REDIS_TOKEN: 'test-token',
        UPSTASH_REDIS_REST_URL: 'http://redis-rest:80',
        LOCAL_SEED_STARTUP_DELAY_MS: '0',
        LOCAL_SEED_BETWEEN_JOBS_MS: '0',
      },
      signal: controller.signal,
      now: () => 10_000,
      runJob: async (job) => {
        started.push(job.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (started.length === 2) controller.abort();
        return { ok: true, durationMs: 1 };
      },
    });

    assert.deepEqual(started, ['military-flights', 'canada-alerts-alberta']);
    assert.equal(maxActive, 1);
  });

  it('maps the Docker token without exposing or weakening it', () => {
    const inherited = createSeederEnv({
      REDIS_TOKEN: 'local-secret-token',
      UPSTASH_REDIS_REST_URL: 'http://redis-rest:80',
    });
    assert.equal(inherited.UPSTASH_REDIS_REST_TOKEN, 'local-secret-token');
    assert.equal(inherited.CHAIN_FORECAST_SEED_ON_MILITARY, '0');
    assert.equal(inherited.WM_ENABLE_NONCOMMERCIAL_ADSB_GAP_FILL, '0');

    assert.throws(
      () => createSeederEnv({ UPSTASH_REDIS_REST_URL: 'http://redis-rest:80' }),
      /REDIS_TOKEN/,
    );
    assert.throws(
      () => createSeederEnv({
        REDIS_TOKEN: 'one',
        UPSTASH_REDIS_REST_TOKEN: 'two',
        UPSTASH_REDIS_REST_URL: 'http://redis-rest:80',
      }),
      /must match/,
    );
  });

  it('Compose uses the dedicated bounded scheduler target', () => {
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const gpsjam = readFileSync(join(root, 'scripts/fetch-gpsjam.mjs'), 'utf8');

    assert.match(compose, /local-seed-scheduler:/);
    assert.match(compose, /target: seed-scheduler/);
    assert.match(compose, /mem_limit:/);
    assert.match(compose, /cpus:/);
    assert.match(dockerfile, /AS seed-scheduler/);
    assert.doesNotMatch(gpsjam, /maskToken|Token: \$\{/);
  });
});
