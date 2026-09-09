interface DeckCompatibleMap {
  readonly transform?: unknown;
  readonly _camera?: { readonly transform: unknown };
}

/**
 * deck.gl 9.4's interleaved renderer still reads map.transform for clipping
 * planes, viewport height and terrain elevation. MapLibre 6 moved that state
 * onto _camera. Keep a live, read-only alias rather than a stale snapshot or
 * a second WebGL overlay. Remove when deck.gl supports MapLibre 6 natively.
 * This deliberately isolates the private-API dependency in one tested place.
 */
export function ensureDeckMapTransform(map: DeckCompatibleMap): void {
  if (map.transform !== undefined) return;
  if (!map._camera?.transform) {
    throw new Error('Unsupported MapLibre camera: deck.gl requires a map transform');
  }
  Object.defineProperty(map, 'transform', {
    configurable: true,
    get: () => map._camera?.transform,
  });
}
