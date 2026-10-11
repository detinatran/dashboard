/**
 * Coastal prediction station registry.
 *
 * Lives in `scripts/shared/` rather than the repo-root `shared/` because
 * Railway builds `nixpacks-root-scripts` services with `scripts/` as the build
 * root — `../shared/` is outside that context and would not ship. Verified: no
 * scripts-rooted seeder imports `../shared/`; the ones that do are dockerfile-mode.
 *
 * A station is a CONFIGURED PREDICTION SITE, not a city. One city may hold
 * several sites (London → Thames Barrier, Chelsea, Silvertown) with different
 * coordinates, providers, datums and models. Nothing downstream may branch on
 * city name.
 *
 * `capabilities` is derived at runtime from which model artifacts actually
 * load — never hardcoded true here. A station with no model must report
 * `model_not_configured`, never a fabricated number.
 */

/** @typedef {'environment-agency'} WaterLevelProviderId */
/** @typedef {'open-meteo'} WeatherProviderId */
/** @typedef {'none'|'precomputed'} TideProviderId */

export const COASTAL_STATIONS = Object.freeze([
  Object.freeze({
    id: 'liverpool-gladstone',
    code: 'E70124',
    name: 'Liverpool',
    displayName: 'Liverpool (Gladstone Dock)',
    city: 'Liverpool',
    country: 'GB',
    // Confirmed from EA stations.csv: E70124 / E70139 share this position.
    lat: 53.449670,
    lon: -3.018150,
    timezone: 'Europe/London',
    active: true,

    waterLevelProvider: 'environment-agency',
    // EA measure id. 15-min mean, metres on the LOCAL gauge datum.
    waterLevelExternalId: 'E70124-level-tidal_level-Mean-15_min-m',

    // The same gauge is also published as E70139 in mAOD. Measured across a
    // full day: local_m = mAOD + 4.9300 exactly (stdev 0.000000), so the two
    // are one series on two datums. We train and serve on the LOCAL metre
    // series and record the offset so mAOD can be derived without a refetch.
    datum: 'local-gauge-m',
    datumOffsetToAod: -4.9300,

    weatherProvider: 'open-meteo',
    weatherExternalId: null, // lat/lon addressed

    // Harmonic fit of this station's own 362-day record (utide, 99.32% of
    // variance explained). Derived from the gauge, NOT an official UKHO/
    // Admiralty prediction — never present it as one, and never use for
    // navigation.
    tideProvider: 'harmonic-utide',

    // Sampling cadence of the upstream gauge, in minutes.
    sampleIntervalMin: 15,

    // Nominal full-scale range seen in the archive (used for sanity bounds,
    // not for prediction): ~1.3 m .. ~9.8 m local datum, ~8 m spring range.
    plausibleRangeM: Object.freeze({ min: -1, max: 13 }),
  }),
]);

/** @returns {ReadonlyArray<typeof COASTAL_STATIONS[number]>} */
export function listActiveStations() {
  return COASTAL_STATIONS.filter((s) => s.active);
}

/** @returns {typeof COASTAL_STATIONS[number] | null} */
export function getStation(stationId) {
  return COASTAL_STATIONS.find((s) => s.id === stationId) ?? null;
}

/** Redis key namespace. Versioned like every other domain (`natural:events:v1`). */
export const COASTAL_KEYS = Object.freeze({
  stations: 'coastal:stations:v1',
  observations: (stationId) => `coastal:obs:v1:${stationId}`,
  prediction: (stationId) => `coastal:prediction:v1:${stationId}`,
  health: (stationId) => `coastal:health:v1:${stationId}`,
});
