/**
 * Model adapters, sitting between the pipeline and the model runtime.
 *
 * Two separate models (a station can have either, both or neither):
 *   WaterLevelForecastModel — regression, metres at +1h/+3h/+6h
 *   WarningForecastModel    — classification, anomaly probability per horizon
 *
 * If a model is missing, incompatible or fails to load, `predict()` returns a
 * status instead of a number. An empty panel is better than a made-up level.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FEATURE_VERSION, FEATURE_COUNT } from './coastal-features.mjs';

export const HORIZONS = Object.freeze([1, 3, 6]);

/**
 * onnxruntime-node is CommonJS, so depending on interop its exports end up on
 * the namespace or under `.default`. Resolve it once and fail with a clear
 * error instead of `Cannot read properties of undefined (reading 'create')`.
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
 * Loads the model's metadata file and rejects it if it was trained on a
 * different feature vector. A mismatched model still outputs numbers, they're
 * just wrong, so we check up front.
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
 * ONNX regression model. Sessions are created once per process and reused;
 * the seeder runs long enough that reloading them every tick would be wasteful.
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

      // The band comes from the residual spread on the test split at training
      // time. It's an empirical error band, not a proper predictive interval.
      const sigma = Number(this.metadata?.horizonSigma?.[String(h)] ?? NaN);
      out[`${h}h`] = {
        waterLevel: Number(value.toFixed(3)),
        lowerBound: Number.isFinite(sigma) ? Number((value - 1.96 * sigma).toFixed(3)) : null,
        upperBound: Number.isFinite(sigma) ? Number((value + 1.96 * sigma).toFixed(3)) : null,
        // v1 predicts the level directly. Without a tide source we can't split it
        // into tide + residual yet.
        predictedTide: null,
        predictedResidual: null,
      };
    }
    return { status: 'ready', horizons: out, modelVersion: this.metadata?.modelVersion ?? null };
  }
}

/**
 * TideWISE-style warning model. Same shape as the regression model but loaded
 * separately: a station can have regression without a warning model, and then
 * it reports that instead of guessing a probability from the regression.
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
      // Per-horizon thresholds from the metadata (not a fixed 0.5).
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
