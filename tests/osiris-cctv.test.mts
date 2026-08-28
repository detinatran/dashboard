import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getOsirisCctvCamera,
  listOsirisCctvCameras,
} from '../src/services/webcams/osiris-cctv.ts';
import {
  nearestWebcamFrom,
  webcamDistanceKm,
} from '../src/services/webcams/index.ts';

describe('OSIRIS CCTV fallback catalogue', () => {
  it('returns the Sofia camera from the reference workflow', () => {
    const cameras = listOsirisCctvCameras({ w: 23, s: 42.5, e: 23.6, n: 42.9 });
    const camera = cameras.find((entry) => entry.webcamId === 'osiris-bg-sofia-tsarigradsko-uab');
    assert.equal(camera?.title, 'Tsarigradsko Shose (UAB)');
    assert.equal(camera?.source, 'UAB / KAMEPA');
    assert.equal(camera?.streamType, 'jpg');
  });

  it('returns a public Starbase camera for the selected Starbase marker', () => {
    const cameras = listOsirisCctvCameras({ w: -97.3, s: 25.8, e: -97, n: 26.2 });
    const camera = cameras.find((entry) => entry.webcamId === 'osiris-us-tx-starbase-labpadre-rover');
    assert.equal(camera?.title, 'Starbase Rover Cam');
    assert.equal(camera?.source, 'LABPADRE SPACE');
    assert.equal(camera?.streamType, 'iframe');
    assert.match(camera?.streamUrl ?? '', /youtube-nocookie\.com/);
  });

  it('filters by viewport and returns defensive copies', () => {
    assert.deepEqual(listOsirisCctvCameras({ w: -10, s: -10, e: 10, n: 10 }), []);
    const first = getOsirisCctvCamera('osiris-bg-sofia-tsarigradsko-uab');
    assert.ok(first);
    first.title = 'mutated';
    assert.equal(
      getOsirisCctvCamera('osiris-bg-sofia-tsarigradsko-uab')?.title,
      'Tsarigradsko Shose (UAB)',
    );
  });

  it('supports viewports that cross the antimeridian', () => {
    const cameras = listOsirisCctvCameras({ w: 170, s: -90, e: 30, n: 90 });
    assert.ok(cameras.some((camera) => camera.country === 'Bulgaria'));
  });

  it('resolves the closest camera within the selected-location radius', () => {
    const sofia = getOsirisCctvCamera('osiris-bg-sofia-tsarigradsko-uab');
    assert.ok(sofia);
    const nearest = nearestWebcamFrom([sofia], { lat: 42.66, lon: 23.38 }, 10);
    assert.equal(nearest?.camera.webcamId, sofia.webcamId);
    assert.ok((nearest?.distanceKm ?? Infinity) < 1);
    assert.equal(nearestWebcamFrom([sofia], { lat: 0, lon: 0 }, 10), null);
    assert.equal(webcamDistanceKm({ lat: sofia.lat, lon: sofia.lng }, sofia), 0);
  });
});
