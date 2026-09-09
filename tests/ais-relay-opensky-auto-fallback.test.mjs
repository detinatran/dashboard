import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const relaySource = readFileSync(resolve(import.meta.dirname, '../scripts/ais-relay.cjs'), 'utf8');

function extractFunction(source, name) {
  const signature = `async function ${name}()`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

const selectionSource = extractFunction(relaySource, 'fetchTheaterPostureFlights');

function buildSelection({ automatedOpenSky = false, adsbLol = null, wingbits = null, openSky = [] } = {}) {
  let openSkyCalls = 0;
  const factory = new Function(
    'fetchTheaterFlightsFromAdsbLol',
    'fetchTheaterFlightsFromWingbits',
    'fetchTheaterFlightsFromOpenSky',
    'OPENSKY_AUTOMATED_FALLBACK_ENABLED',
    'console',
    `return (${selectionSource});`,
  );
  const select = factory(
    async () => adsbLol,
    async () => wingbits,
    async () => {
      openSkyCalls += 1;
      return openSky;
    },
    automatedOpenSky,
    { warn() {} },
  );
  return { select, get openSkyCalls() { return openSkyCalls; } };
}

describe('AIS relay automated OpenSky fallback', () => {
  it('defaults the licence-sensitive flag off when the env opt-in is missing', async () => {
    assert.match(
      relaySource,
      /const OPENSKY_AUTOMATED_FALLBACK_ENABLED = process\.env\.WM_ENABLE_OPENSKY_AUTOMATED_FALLBACK === '1';/,
    );

    const harness = buildSelection({
      automatedOpenSky: false,
      adsbLol: null,
      wingbits: null,
      openSky: [{ id: 'must-not-be-fetched' }],
    });
    const result = await harness.select();

    assert.equal(harness.openSkyCalls, 0);
    assert.deepEqual(result, { flights: [], flightSource: 'vessel-only' });
  });

  it('allows a separately licensed operator to opt in explicitly', async () => {
    const harness = buildSelection({
      automatedOpenSky: true,
      adsbLol: null,
      wingbits: null,
      openSky: [{ id: 'licensed-flight' }],
    });
    const result = await harness.select();

    assert.equal(harness.openSkyCalls, 1);
    assert.deepEqual(result, {
      flights: [{ id: 'licensed-flight' }],
      flightSource: 'opensky',
    });
  });
});
