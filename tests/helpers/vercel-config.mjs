// Shared loader for the web app's slice of `vercel.json`.
//
// vercel.json runs in Vercel services mode: the top level holds only the public
// ingress (redirects + service rewrites), while the app's own build settings,
// path rewrites and headers live under `services.app`. Deploy-contract tests
// were written against the flat single-project layout, so this returns that
// same shape — `rewrites`, `headers`, `buildCommand`, … from the app service and
// `redirects` from the top level — and the assertions stay unchanged.
//
// Throws when `services.app` is missing so a renamed service fails loudly
// instead of every rule lookup silently returning undefined (a false PASS for
// the "must not exist" style assertions).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERCEL_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../vercel.json');
export const APP_SERVICE = 'app';

export function readVercelConfig() {
  return JSON.parse(readFileSync(VERCEL_CONFIG_PATH, 'utf8'));
}

export function loadVercelAppConfig() {
  const config = readVercelConfig();
  const app = config.services?.[APP_SERVICE];
  if (!app) throw new Error(`vercel.json: services.${APP_SERVICE} is missing`);
  return {
    ...app,
    redirects: config.redirects ?? [],
    rewrites: app.rewrites ?? [],
    headers: app.headers ?? [],
  };
}
