/**
 * Model adapters — the boundary between the pipeline and whatever runtime a
 * model happens to use.
 *
 * Two separate tasks, deliberately not fused (a station may have either, both
 * or neither):
 *   WaterLevelForecastModel — regression, metres at +1h/+3h/+6h
 *   WarningForecastModel    — classification, anomaly probability per horizon
 *
 * Refusal is a first-class outcome. When a model is absent, incompatible or
 * fails to load, `predict()` returns a status — never a number. A fabricated
 * water level is worse than a blank panel.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FEATURE_VERSION, FEATURE_COUNT } from './coastal-features.mjs';

export const HORIZONS = Object.freeze([1, 3, 6]);

/**
 * onnxruntime-node is CommonJS. Depending on the interop path, its exports land
 * either on the namespace root or under `.default`. Normalise once so a wrong
 * guess fails with a clear message instead of
 * `Cannot read properties of undefined (reading 'create')`.
 */
let ortModule = null;
async function loadOrt() {
  if (ortModule) return ortModule;
  const mod = await import('onnxruntime-node');
  const resolved = mod?.InferenceSession ? mod : mod?.default;
  if (!resolved?.InferenceSession || !resolved?.Tensor) {
    throw new Error('onnxruntime-node did not expose InferenceSession/Tensor');
  }
  ortModule = resolved;
  return ortModule;
}

/** Model artifacts live outside the repo; the seeder mounts/downloads them. */
export function modelDir(envVar, fallback) {
  const v = String(process.env[envVar] || '').trim();
  return v || fallback;
}

/**
 * Load a model's metadata sidecar and refuse anything that does not match the
 * feature builder currently compiled in. A model trained on a different vector
 * still produces confident numbers — that silent mismatch is the failure this
 * check exists to prevent.
 */
export function loadModelMetadata(dir, stationId) {
  const path = join(dir, `${stationId}.meta.json`);
  if (!existsSync(path)) return { status: 'model_not_configured' };
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { status: 'model_incompatible', reason: `unreadable metadata: ${err?.message || err}` };
  }
  if (meta.featureVersion !== FEATURE_VERSION) {
    return {
      status: 'model_incompatible',
      reason: `featureVersion ${meta.featureVersion} != builder ${FEATURE_VERSION}`,
    };
  }
  if (Number(meta.expectedFeatureCount) !== FEATURE_COUNT) {
    return {
      status: 'model_incompatible',
      reason: `expectedFeatureCount ${meta.expectedFeatureCount} != builder ${FEATURE_COUNT}`,
    };
  }
  if (meta.stationId && meta.stationId !== stationId) {
    return { status: 'model_incompatible', reason: `model is for station ${meta.stationId}` };
  }
  return { status: 'ready', meta };
}

/**
 * ONNX-backed regression model. Sessions are created once per process and
 * reused — the seeder is long-lived enough that re-reading the graph per tick
 * would be pure waste, and per-request loading is forbidden by design.
 */
export class OnnxWaterLevelModel {
  constructor({ dir, stationId }) {
    this.dir = dir;
    this.stationId = stationId;
    this.sessions = new Map();
    this.metaResult = loadModelMetadata(dir, stationId);
  }

  get status() { return this.metaResult.status; }
  get metadata() { return this.metaResult.meta ?? null; }

  async #session(horizon) {
    if (this.sessions.has(horizon)) return this.sessions.get(horizon);
    const file = join(this.dir, `${this.stationId}.h${horizon}.onnx`);
    if (!existsSync(file)) return null;
    const ort = await loadOrt();
    const session = await ort.InferenceSession.create(file, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    this.sessions.set(horizon, { session, ort });
    return this.sessions.get(horizon);
  }

  /**
   * @param {Float32Array} features
   * @returns {Promise<{status:string, horizons?:Record<string,object>, reason?:string}>}
   */
  async predict(features) {
    if (this.metaResult.status !== 'ready') return { ...this.metaResult };
    if (features.length !== FEATURE_COUNT) {
      return { status: 'model_incompatible', reason: `got ${features.length} features, expected ${FEATURE_COUNT}` };
    }

    const out = {};
    for (const h of HORIZONS) {
      const entry = await this.#session(h);
      if (!entry) return { status: 'model_not_configured', reason: `missing artifact for +${h}h` };
      const { session, ort } = entry;
      const tensor = new ort.Tensor('float32', features, [1, FEATURE_COUNT]);
      const result = await session.run({ [session.inputNames[0]]: tensor });
      const value = Number(result[session.outputNames[0]].data[0]);
      if (!Number.isFinite(value)) {
        return { status: 'inference_failed', reason: `non-finite output at +${h}h` };
      }

      // Interval from the residual spread measured on the held-out test split
      // at training time. It is an empirical error band, not a probabilistic
      // predictive interval, and the metadata says so.
      const sigma = Number(this.metadata?.horizonSigma?.[String(h)] ?? NaN);
      out[`${h}h`] = {
        waterLevel: Number(value.toFixed(3)),
        lowerBound: Number.isFinite(sigma) ? Number((value - 1.96 * sigma).toFixed(3)) : null,
        upperBound: Number.isFinite(sigma) ? Number((value + 1.96 * sigma).toFixed(3)) : null,
        // v1 predicts the level directly: with no astronomical tide source,
        // splitting it into tide + residual would mean inventing both.
        predictedTide: null,
        predictedResidual: null,
      };
    }
    return { status: 'ready', horizons: out, modelVersion: this.metadata?.modelVersion ?? null };
  }
}

/**
 * TideWISE-style warning model. Structurally identical, separately gated: a
 * station may run regression with no warning model, and must then say so
 * rather than deriving a probability from the regression output.
 */
export class OnnxWarningModel {
  constructor({ dir, stationId }) {
    this.dir = dir;
    this.stationId = stationId;
    this.sessions = new Map();
    this.metaResult = loadModelMetadata(dir, stationId);
  }

  get status() { return this.metaResult.status; }
  get metadata() { return this.metaResult.meta ?? null; }

  async predict(features) {
    if (this.metaResult.status !== 'ready') return { ...this.metaResult };
    const out = {};
    for (const h of HORIZONS) {
      const file = join(this.dir, `${this.stationId}.warn.h${h}.onnx`);
      if (!existsSync(file)) return { status: 'model_not_configured', reason: `missing warning artifact +${h}h` };
      if (!this.sessions.has(h)) {
        const ort = await loadOrt();
        this.sessions.set(h, {
          ort,
          session: await ort.InferenceSession.create(file, { executionProviders: ['cpu'] }),
        });
      }
      const { session, ort } = this.sessions.get(h);
      const tensor = new ort.Tensor('float32', features, [1, FEATURE_COUNT]);
      const res = await session.run({ [session.inputNames[0]]: tensor });
      const probRaw = res[session.outputNames[session.outputNames.length - 1]];
      const p = Number(Array.isArray(probRaw?.data) || ArrayBuffer.isView(probRaw?.data)
        ? probRaw.data[probRaw.data.length - 1] : NaN);
      if (!Number.isFinite(p)) return { status: 'inference_failed', reason: `non-finite probability +${h}h` };
      // Thresholds are per-horizon and come from metadata — never a hardcoded 0.5.
      const threshold = Number(this.metadata?.warningThreshold?.[String(h)] ?? NaN);
      out[`${h}h`] = {
        probability: Number(p.toFixed(4)),
        warning: Number.isFinite(threshold) ? p >= threshold : null,
        threshold: Number.isFinite(threshold) ? threshold : null,
      };
    }
    return { status: 'ready', horizons: out, modelVersion: this.metadata?.modelVersion ?? null };
  }
}
