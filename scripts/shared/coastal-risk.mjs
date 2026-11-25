/**
 * Risk levels for coastal stations, kept here instead of in a UI component.
 *
 * This is a model-based risk estimate, not an official flood warning, and it
 * shouldn't be shown as one. It isn't connected to the Environment Agency's
 * warning service, which is why the labels say "model risk" / "estimated
 * anomaly risk".
 */

export const RISK_LEVELS = Object.freeze(['normal', 'advisory', 'watch', 'high']);

/** Default thresholds; a station can override them. */
export const DEFAULT_RISK_THRESHOLDS = Object.freeze({
  advisory: 0.30,
  watch: 0.50,
  high: 0.75,
});

/**
 * `waterLevelForecast` and `latest` aren't used yet: v1 grades risk only from
 * the warning model's probability. They stay in the signature for the station
 * rules we want to add later (absolute level, residual, flood threshold), so
 * callers won't have to change.
 */
export function evaluateRisk({ station, warningForecast }) {
  const thresholds = { ...DEFAULT_RISK_THRESHOLDS, ...(station?.riskThresholds || {}) };

  // No warning model means no probability to grade, so report that instead of
  // deriving a level from the regression output.
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
 * Data freshness, worked out on the server so every client agrees on what
 * "live" means instead of assuming the data is fresh.
 */
export const FRESHNESS_THRESHOLDS = Object.freeze({ liveMaxMin: 30, delayedMaxMin: 90 });

export function classifyFreshness(ageMinutes, thresholds = FRESHNESS_THRESHOLDS) {
  if (!Number.isFinite(ageMinutes)) return 'unknown';
  if (ageMinutes <= thresholds.liveMaxMin) return 'live';
  if (ageMinutes <= thresholds.delayedMaxMin) return 'delayed';
  return 'stale';
}
