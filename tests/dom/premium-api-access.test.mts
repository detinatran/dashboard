import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let apiKeyPresent = false;
let proSignal = false;

vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({
    present: apiKeyPresent,
    valid: apiKeyPresent,
    source: apiKeyPresent ? 'env' : 'missing',
  }),
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => proSignal,
}));

const { hasPremiumAccess, hasPremiumApiAccess } = await import('@/services/panel-gating');

beforeEach(() => {
  apiKeyPresent = false;
  proSignal = false;
  vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('premium API access', () => {
  it('unlocks the local demo UI without claiming API credentials', () => {
    expect(hasPremiumAccess()).toBe(true);
    expect(hasPremiumApiAccess()).toBe(false);
  });

  it('allows API calls when a configured license key is present', () => {
    apiKeyPresent = true;
    expect(hasPremiumApiAccess()).toBe(true);
  });

  it('allows API calls for authenticated Pro entitlement signals', () => {
    proSignal = true;
    expect(hasPremiumApiAccess()).toBe(true);
  });
});
