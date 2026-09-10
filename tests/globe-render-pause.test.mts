import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { transformSync } from 'esbuild';

// Exercise the production lifecycle methods without requiring a WebGL context.
const source = readFileSync(new URL('../src/components/GlobeMap.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GlobeMap.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'GlobeMap');
assert.ok(declaration && ts.isClassDeclaration(declaration));
const methods = ['setRenderPaused', 'wakeGlobe', 'startExtrasLoop'].map((name) => {
  const method = declaration.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method, name);
  return method.getText(ast);
});
const { code } = transformSync(`export class Probe { ${methods.join('\n')} }`, { loader: 'ts', format: 'esm' });
const { Probe } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

describe('globe render pause lifecycle', () => {
  it('stops both animation loops, flushes pending data once, and restores controls on resume', () => {
    const saved = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
    const cancelled: number[] = [];
    let frames = 0;
    let paused = 0;
    let resumed = 0;
    let flushed = 0;
    globalThis.document = { hidden: false } as Document;
    globalThis.requestAnimationFrame = () => ++frames;
    globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); };
    try {
      const probe = Object.assign(new Probe(), {
        renderPaused: false, destroyed: false, isGlobeAnimating: true,
        extrasAnimFrameId: 42, pendingFlushWhilePaused: false,
        viewportAutoRotateBeforeMove: null,
        controls: { autoRotate: true, enableDamping: true },
        globe: { pauseAnimation: () => paused++, resumeAnimation: () => resumed++ },
        outerGlow: { rotation: { y: 0 } },
        flushMarkers: () => flushed++, scheduleIdlePause: () => {},
      });
      probe.setRenderPaused(true);
      assert.equal(paused, 1);
      assert.deepEqual(cancelled, [42]);
      assert.equal(probe.extrasAnimFrameId, null);
      assert.deepEqual(probe.controls, { autoRotate: false, enableDamping: false });
      probe.wakeGlobe();
      probe.startExtrasLoop();
      assert.equal(resumed, 0);
      assert.equal(frames, 0);
      probe.setRenderPaused(false);
      assert.equal(flushed, 1);
      assert.equal(resumed, 1);
      assert.equal(frames, 1);
      assert.deepEqual(probe.controls, { autoRotate: true, enableDamping: true });
      probe.setRenderPaused(false);
      assert.equal(flushed, 1);
      assert.equal(frames, 1);
      globalThis.document = { hidden: true } as Document;
      probe.extrasAnimFrameId = null;
      probe.isGlobeAnimating = false;
      probe.wakeGlobe();
      probe.startExtrasLoop();
      assert.equal(resumed, 1);
      assert.equal(frames, 1);
    } finally {
      Object.assign(globalThis, saved);
    }
  });
});
