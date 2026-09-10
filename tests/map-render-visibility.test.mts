import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MapRenderVisibility } from '../src/utils/map-render-visibility.ts';

describe('map visibility pause ownership', () => {
  it('preserves a modal pause while leaving and re-entering the viewport', () => {
    const states: boolean[] = [];
    const gate = new MapRenderVisibility((paused) => states.push(paused));
    gate.setManual(true);
    gate.setOffscreen(true);
    gate.setOffscreen(false);
    assert.equal(states.at(-1), true);
    gate.setManual(false);
    assert.equal(states.at(-1), false);
  });

  it('does not wake an offscreen map when the modal closes', () => {
    let paused = false;
    const gate = new MapRenderVisibility((value) => { paused = value; });
    gate.setOffscreen(true);
    gate.setManual(false);
    gate.apply(); // Also reapply when a deferred renderer is ready.
    assert.equal(paused, true);
    gate.setOffscreen(false);
    assert.equal(paused, false);
  });

  it('tracks hidden tabs, observes the viewport, and disconnects on teardown', () => {
    const previous = globalThis.IntersectionObserver;
    let visibility: (() => void) | undefined;
    let intersection: IntersectionObserverCallback;
    let disconnected = false;
    const states: boolean[] = [];
    const doc = {
      hidden: true,
      addEventListener: (_: string, callback: () => void) => { visibility = callback; },
      removeEventListener: (_: string, callback: () => void) => { assert.equal(callback, visibility); visibility = undefined; },
    };
    const element = { ownerDocument: doc } as unknown as HTMLElement;
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { intersection = callback; }
      observe(target: Element) { assert.equal(target, element); }
      disconnect() { disconnected = true; }
    } as unknown as typeof IntersectionObserver;
    try {
      const gate = new MapRenderVisibility((paused) => states.push(paused));
      gate.observe(element);
      assert.equal(states.at(-1), true);
      doc.hidden = false;
      visibility!();
      assert.equal(states.at(-1), false);
      intersection!([{ target: element, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      assert.equal(states.at(-1), true);
      intersection!([
        { target: element, isIntersecting: false } as IntersectionObserverEntry,
        { target: element, isIntersecting: true } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
      assert.equal(states.at(-1), false);
      gate.destroy();
      assert.equal(disconnected, true);
      assert.equal(visibility, undefined);
      const count = states.length;
      intersection!([{ target: element, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      assert.equal(states.length, count, 'late callbacks cannot wake a destroyed renderer');
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });
});
