/**
 * Risk policy — a separate, configurable service, not logic inside a component.
 *
 * WORDING MATTERS: this is a MODEL RISK estimate. It is not an official flood
 * warning and must never be presented as one; nothing here is integrated with
 * the Environment Agency's statutory warning service. The labels deliberately
 * read "model risk" / "estimated anomaly risk".
 */

export const RISK_LEVELS = Object.freeze(['normal', 'advisory', 'watch', 'high']);

/** Defaults; per-station overrides may replace them. Never hardcoded as 0.5. */
export const DEFAULT_RISK_THRESHOLDS = Object.freeze({
  advisory: 0.30,
  watch: 0.50,
  high: 0.75,
});

/**
 * `waterLevelForecast` and `latest` are accepted but unused in v1: risk is
 * graded purely from the warning model's anomaly probability. They stay in the
 * signature because the station-specific rules this policy is meant to grow
 * into (absolute level, residual, flood threshold) read exactly those two, and
 * changing the call shape later would touch every caller.
 */
export function evaluateRisk({ station, warningForecast }) {
  const thresholds = { ...DEFAULT_RISK_THRESHOLDS, ...(station?.riskThresholds || {}) };

  // Without a warning model there is no anomaly probability to grade. Say so
  // rather than manufacturing a level from the regression output.
  if (!warningForecast || warningForecast.status !== 'ready') {
    return {
      level: 'unknown',
      reason: 'No warning model is configured for this site',
      basis: 'none',
      thresholds,
    };
  }

  const probs = Object.entries(warningForecast.horizons || {})
    .map(([k, v]) => ({ horizon: k, p: Number(v?.probability) }))
    .filter((x) => Number.isFinite(x.p));
  if (!probs.length) {
    return { level: 'unknown', reason: 'Warning model returned no probabilities', basis: 'none', thresholds };
  }

  const worst = probs.reduce((a, b) => (b.p > a.p ? b : a));
  let level = 'normal';
  if (worst.p >= thresholds.high) level = 'high';
  else if (worst.p >= thresholds.watch) level = 'watch';
  else if (worst.p >= thresholds.advisory) level = 'advisory';

  const pct = Math.round(worst.p * 100);
  const reason = level === 'normal'
    ? `Estimated anomaly risk below ${Math.round(thresholds.advisory * 100)}% across all horizons`
    : `Estimated ${pct}% anomaly probability within ${worst.horizon}`;

  return { level, reason, basis: 'warning-model', worstHorizon: worst.horizon, probability: worst.p, thresholds };
}

/**
 * Data freshness. Computed server-side so the client never decides what "LIVE"
 * means — a UI that assumes freshness because the feature is enabled will show
 * a confident stale number.
 */
export const FRESHNESS_THRESHOLDS = Object.freeze({ liveMaxMin: 30, delayedMaxMin: 90 });

export function classifyFreshness(ageMinutes, thresholds = FRESHNESS_THRESHOLDS) {
  if (!Number.isFinite(ageMinutes)) return 'unknown';
  if (ageMinutes <= thresholds.liveMaxMin) return 'live';
  if (ageMinutes <= thresholds.delayedMaxMin) return 'delayed';
  return 'stale';
}
