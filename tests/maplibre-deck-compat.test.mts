import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDeckMapTransform } from '../src/utils/maplibre-deck-compat.ts';

describe('MapLibre 6 / deck.gl transform compatibility', () => {
  it('exposes a live transform across resize and camera replacement', () => {
    const map = { _camera: { transform: { height: 600, _nearZ: 1, _farZ: 1000 } } };
    ensureDeckMapTransform(map);
    assert.equal(Reflect.get(map, 'transform'), map._camera.transform);
    map._camera.transform.height = 900;
    assert.equal(Reflect.get(map, 'transform').height, 900);
    map._camera = { transform: { height: 400, _nearZ: 2, _farZ: 2000 } };
    assert.equal(Reflect.get(map, 'transform'), map._camera.transform);
    assert.equal(Object.getOwnPropertyDescriptor(map, 'transform')?.set, undefined);
  });

  it('leaves existing transform implementations untouched and is idempotent', () => {
    const map = { transform: { height: 600 } };
    const descriptor = Object.getOwnPropertyDescriptor(map, 'transform');
    ensureDeckMapTransform(map);
    ensureDeckMapTransform(map);
    assert.deepEqual(Object.getOwnPropertyDescriptor(map, 'transform'), descriptor);
  });

  it('does not silently hide an unsupported camera layout', () => {
    assert.throws(() => ensureDeckMapTransform({}), /Unsupported MapLibre camera/);
  });
});
