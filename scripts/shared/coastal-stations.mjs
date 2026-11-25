/**
 * List of coastal prediction stations.
 *
 * This lives in `scripts/shared/` and not the root `shared/` because Railway
 * builds the `nixpacks-root-scripts` services with `scripts/` as the root, so
 * `../shared/` wouldn't be shipped. (Only the dockerfile-based seeders import
 * from `../shared/`.)
 *
 * A station is a prediction site, not a city. One city can have several sites
 * (London: Thames Barrier, Chelsea, Silvertown) with their own coordinates,
 * providers, datums and models, so don't key anything off the city name.
 *
 * `capabilities` is worked out at runtime from which model files actually
 * load, so nothing is hardcoded to true here. A station without a model
 * reports `model_not_configured`.
 */

/** @typedef {'environment-agency'} WaterLevelProviderId */
/** @typedef {'open-meteo'} WeatherProviderId */
/** @typedef {'none'|'harmonic-utide'} TideProviderId */

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
    // EA measure id. 15-min mean, metres on the local gauge datum.
    waterLevelExternalId: 'E70124-level-tidal_level-Mean-15_min-m',

    // The same gauge is also published as E70139 in mAOD. Over a full day
    // local_m = mAOD + 4.93 exactly, so it's one series on two datums. We use the
    // local series and keep the offset to get mAOD without refetching.
    datum: 'local-gauge-m',
    datumOffsetToAod: -4.9300,

    weatherProvider: 'open-meteo',
    weatherExternalId: null, // lat/lon addressed

    // Harmonic fit of this station's own 362-day record (utide, 99.32% of
    // variance explained). It's derived from the gauge, not an official
    // UKHO/Admiralty prediction, so don't present it as one or use it to navigate.
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
