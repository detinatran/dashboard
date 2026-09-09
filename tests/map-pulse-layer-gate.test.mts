import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { transformSync } from 'esbuild';

// Execute the real predicate without loading WebGL or browser-only imports.
const source = readFileSync(new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('DeckGLMap.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'DeckGLMap');
assert.ok(declaration && ts.isClassDeclaration(declaration));
const method = declaration.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'needsPulseAnimation');
assert.ok(method);
const { code } = transformSync(`export class Probe { ${method.getText(ast)} }`, { loader: 'ts', format: 'esm' });
const { Probe } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function fixture() {
  return {
    state: { layers: { protests: false, hotspots: false, positiveEvents: false, kindness: false } },
    hasRecentNews: () => false,
    hasRecentRiot: () => true,
    hotspots: [{ hasBreaking: true }],
    positiveEvents: [{ count: 12 }],
    kindnessPoints: [{ type: 'real' }],
  };
}

describe('map pulse layer gating', () => {
  it('does not animate cached events belonging only to hidden layers', () => {
    assert.equal(Probe.prototype.needsPulseAnimation.call(fixture(), 100), false);
  });

  for (const key of ['protests', 'hotspots', 'positiveEvents', 'kindness'] as const) {
    it(`starts for visible ${key} and stops after it is hidden`, () => {
      const state = fixture();
      state.state.layers[key] = true;
      assert.equal(Probe.prototype.needsPulseAnimation.call(state, 100), true);
      state.state.layers[key] = false;
      assert.equal(Probe.prototype.needsPulseAnimation.call(state, 100), false);
    });
  }

  it('still animates recent news, which has no layer toggle', () => {
    const state = fixture();
    state.hasRecentNews = () => true;
    assert.equal(Probe.prototype.needsPulseAnimation.call(state, 100), true);
  });
});
