import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// Clerk -> Solana mobile wallet -> React Native -> Metro pulled image-size
// into the web install. Metro 0.83.8 removes the vulnerable dependency without
// changing Clerk's major version or replacing the React Native peer tree.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

describe('Metro image parser security baseline', () => {
  it('keeps the 0.83 family on the compatible upstream security patch', () => {
    for (const name of ['metro', 'metro-config', 'metro-transform-worker']) {
      assert.equal(manifest.overrides[`${name}@0.83`], '0.83.8');
      assert.equal(lock.packages[`node_modules/${name}`].version, '0.83.8');
    }
    assert.equal(lock.packages['node_modules/@clerk/clerk-js'].version, '6.31.0');
  });

  it('does not reintroduce image-size through a nested dependency', () => {
    assert.deepEqual(Object.keys(lock.packages).filter((path) => path.endsWith('/node_modules/image-size') || path === 'node_modules/image-size'), []);
    assert.equal(lock.packages['node_modules/metro'].dependencies['image-size'], undefined);
  });

  it('preserves normal PNG dimensions through Metro’s actual asset API', () => {
    const { getAssetSize } = require('metro/private/Assets');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    assert.deepEqual(getAssetSize('png', png, 'pixel.png'), { width: 1, height: 1 });
  });

  it('rejects a zero-length ICNS entry disguised as PNG without hanging', () => {
    // Isolate the regression in a bounded child so a vulnerable parser cannot
    // hang the entire test runner. No server or external input is involved.
    const code = `
      const assert = require('node:assert/strict');
      const { getAssetSize } = require(${JSON.stringify(require.resolve('metro/private/Assets'))});
      const malformed = Buffer.alloc(16);
      malformed.write('icns');
      malformed.writeUInt32BE(16, 4);
      malformed.write('ic07', 8);
      assert.throws(() => getAssetSize('png', malformed, 'malformed.png'));
    `;
    const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
});
