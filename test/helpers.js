// Shared test utilities. Each test file still runs in its own process under
// `node --test`, but going through these helpers keeps env handling and fetch
// mocking identical everywhere (and survives a future move to a shared-process
// runner).

import { reloadCredentialsFromEnv } from "../build/core/config.js";

export const realFetch = globalThis.fetch;

/**
 * Reset the credential/policy env to the baseline most tests assume:
 * valid instance, Basic auth, no retries, no policy restrictions.
 */
export function baselineEnv() {
  process.env.SN_INSTANCE = "ven03019.service-now.com";
  process.env.SN_USER = "alice";
  process.env.SN_PASSWORD = "s3cret";
  process.env.SN_MAX_RETRIES = "0";
  delete process.env.SN_AUTH;
  delete process.env.SN_OAUTH_CLIENT_ID;
  delete process.env.SN_OAUTH_CLIENT_SECRET;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  // Credentials live in the config store; staging env vars alone is not enough.
  reloadCredentialsFromEnv();
}

/** Run `fn` with the given env overrides, restoring the previous values after. */
export async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadCredentialsFromEnv();
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  }
}

/** Run `fn` with `globalThis.fetch` replaced by `handler`, then restore it. */
export async function withFetch(handler, fn) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

export const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
