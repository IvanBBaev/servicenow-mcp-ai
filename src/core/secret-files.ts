import { readFileSync } from "node:fs";
import { ServiceNowError } from "./errors.js";
import { isSecretFileSource } from "./settings-manifest.js";

/**
 * D-5 / L2-12 — `<KEY>_FILE` secret sources.
 *
 * Container platforms (Docker / Compose / Swarm secrets, Kubernetes secret
 * volumes) hand secrets over as files, not as environment variables. For each
 * secret setting below, `<KEY>_FILE=/run/secrets/x` loads the value of `<KEY>`
 * from that file:
 *
 *   SN_PASSWORD_FILE             -> SN_PASSWORD
 *   SN_API_KEY_FILE              -> SN_API_KEY
 *   SN_BEARER_TOKEN_FILE         -> SN_BEARER_TOKEN
 *   SN_OAUTH_CLIENT_SECRET_FILE  -> SN_OAUTH_CLIENT_SECRET
 *   SN_OAUTH_REFRESH_TOKEN_FILE  -> SN_OAUTH_REFRESH_TOKEN
 *   SN_HTTP_TOKEN_FILE           -> SN_HTTP_TOKEN
 *
 * plus the per-profile forms `SN_PROFILE_<NAME>_<SECRET>_FILE` for the five
 * ServiceNow secrets. Rules:
 *
 * - one trailing newline (`\n` or `\r\n`) is trimmed — `echo secret > file`
 *   works; any other whitespace is kept, as it may be part of the secret;
 * - setting both `<KEY>` and `<KEY>_FILE` is a startup error that names the
 *   pair — the server never guesses which one was meant;
 * - an unreadable or empty file is a startup error that names the setting and
 *   the OS reason, never the file's content.
 *
 * The pre-existing file settings keep their own meaning and are NOT handled
 * here: SN_TOKEN_FILE (bearer token re-read on 401), SN_OAUTH_JWT_KEY_FILE and
 * the SN_TLS_*_FILE PEM paths. The pattern cannot match them.
 *
 * E-4: the set of `_FILE` sources is derived from the settings manifest —
 * every setting flagged `fileSource` (profile forms only where the setting is
 * profile-scoped), so a new secret setting gains its `_FILE` form by
 * declaration alone.
 */
const SECRET_FILE_RE = { test: isSecretFileSource };

/**
 * Keys whose current value was loaded from a `_FILE` source, with the value
 * injected. A repeated resolve (loadEnv runs again in tests and after a
 * profile switch) must not mistake its own earlier injection for a conflict.
 */
const injectedByEnv = new WeakMap<NodeJS.ProcessEnv, Map<string, string>>();

/** True when `name` is one of the `<KEY>_FILE` secret settings. */
export function isSecretFileKey(name: string): boolean {
  return SECRET_FILE_RE.test(name);
}

/**
 * The `<KEY>_FILE` setting that currently supplies `key`, or undefined. Used
 * by the env-file writer to refuse persisting a value that would then collide
 * with its file source on the next start.
 */
export function secretFileSourceFor(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fileKey = `${key}_FILE`;
  return isSecretFileKey(fileKey) && env[fileKey]?.trim() ? fileKey : undefined;
}

/** Read one secret file, trimming a single trailing newline. */
export function readSecretFile(fileKey: string, path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code ??
      (error instanceof Error ? error.message : String(error));
    const failure = new ServiceNowError(
      `Cannot read ${fileKey} (${path}): ${reason}`,
      undefined,
      undefined,
      {
        code: "UNREADABLE",
        hint: `Check that ${fileKey} names a readable file.`,
      },
    );
    throw Object.assign(failure, { cause: error });
  }
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") {
    throw new ServiceNowError(
      `${fileKey} (${path}) is empty`,
      undefined,
      undefined,
      { code: "UNREADABLE", hint: `Write the secret into ${path}.` },
    );
  }
  return value;
}

/**
 * Resolve every `<KEY>_FILE` secret setting in `env` into `<KEY>`. Returns the
 * keys that were loaded (names only). Throws on a `<KEY>` / `<KEY>_FILE`
 * conflict or an unreadable / empty file.
 */
export function resolveSecretFiles(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const loaded: string[] = [];
  let injected = injectedByEnv.get(env);
  if (!injected) {
    injected = new Map();
    injectedByEnv.set(env, injected);
  }
  for (const fileKey of Object.keys(env).sort()) {
    if (!SECRET_FILE_RE.test(fileKey)) continue;
    const path = env[fileKey]?.trim();
    if (!path) continue;
    const key = fileKey.slice(0, -"_FILE".length);
    const current = env[key];
    const ours = current !== undefined && injected.get(key) === current;
    if (current !== undefined && current.trim() !== "" && !ours) {
      throw new ServiceNowError(
        `Both ${key} and ${fileKey} are set — set only one of them`,
        undefined,
        undefined,
        { code: "NOT_CONFIGURED", hint: `Unset ${key} or ${fileKey}.` },
      );
    }
    const value = readSecretFile(fileKey, path);
    env[key] = value;
    injected.set(key, value);
    loaded.push(key);
  }
  return loaded;
}
