import { describe, expect, it, vi } from 'vitest';
import { fetchFirstUsableJson } from '@/services/military-flights';

/**
 * Drives the real helper from src/services/military-flights.ts.
 *
 * The regression this guards: fetchQueryRegion tries the dev/relay proxy first
 * and, on localhost, falls back to OpenSky directly. A network-level failure —
 * the dev proxy dropping the socket when OpenSky is unreachable — REJECTS the
 * fetch rather than returning `!response.ok`. When a single try/catch wrapped
 * the whole loop, that rejection skipped every remaining URL, so the fallback
 * never ran in the one case it exists for.
 */
function ok(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}
function notOk(status = 502) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('fetchFirstUsableJson', () => {
  it('falls through to the next URL when the first REJECTS at the network level', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'proxy') throw new TypeError('Failed to fetch');
      return ok({ states: [['abc']] });
    }) as unknown as typeof fetch;

    const data = await fetchFirstUsableJson<{ states: unknown[] }>(['proxy', 'direct'], fetchImpl);

    expect(data).toEqual({ states: [['abc']] });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])))
      .toEqual(['proxy', 'direct']);
  });

  it('falls through when the first responds with a non-ok status', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return String(input) === 'proxy' ? notOk() : ok({ states: [] });
    }) as unknown as typeof fetch;

    await expect(fetchFirstUsableJson(['proxy', 'direct'], fetchImpl)).resolves.toEqual({ states: [] });
    expect(seen).toEqual(['proxy', 'direct']);
  });

  it('returns null only once every URL is exhausted', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(fetchFirstUsableJson(['proxy', 'direct'], fetchImpl)).resolves.toBeNull();
    expect(seen).toEqual(['proxy', 'direct']);
  });

  it('sends the JSON Accept header the OpenSky endpoints expect', async () => {
    let headers: HeadersInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      headers = init?.headers;
      return ok({ states: [] });
    }) as unknown as typeof fetch;

    await fetchFirstUsableJson(['proxy'], fetchImpl);
    expect(headers).toEqual({ Accept: 'application/json' });
  });
});
