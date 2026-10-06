/**
 * Pure configuration logic for the extension: settings → server environment,
 * stored credentials → server environment, env-file path expansion. No `vscode`
 * import, so every function here is unit-tested under plain Node
 * (`src/test/config.test.ts`).
 */
import { isAbsolute, join, resolve } from "node:path";

/** The npm package the extension launches. */
export const SERVER_PACKAGE = "servicenow-mcp-ai";

/**
 * D-6 (B9): the server major the extension launches. `npx -y` resolves the
 * newest release inside this range, so a new server major never reaches an
 * installed extension silently — it ships with an extension that raises the
 * pin. The extension is versioned in lockstep with the server
 * (`npm run version:sync`), so the range is always the `package.json` major:
 * `test/distribution.test.js` fails a major bump that leaves it behind (the
 * 3.0.0 bump raises it to `3.x`). Every launcher (MCP definition, doctor,
 * http transport) goes through `SERVER_SPEC`; the same test keeps it that way.
 *
 * Written `N.x` rather than `^N`: npm treats both as `>=N.0.0 <N+1.0.0-0`, but
 * on Windows `npx` is spawned through `cmd.exe`, where `^` is the escape
 * character and would be stripped or mangled.
 */
export const SERVER_VERSION_RANGE = "2.x";

/** The npm spec every launcher passes to `npx -y`. */
export const SERVER_SPEC = `${SERVER_PACKAGE}@${SERVER_VERSION_RANGE}`;

/** Settings section; every key below lives under `servicenowMcp.*`. */
export const SETTINGS_SECTION = "servicenowMcp";

/** SecretStorage key holding the signed-in credentials (one JSON document). */
export const SECRET_KEY = "servicenowMcp.credentials";

export type Transport = "stdio" | "http";

/** The extension settings, already read from the workspace configuration. */
export interface ExtensionSettings {
  envFile: string;
  packages: string[];
  transport: Transport;
}

/** Auth methods the sign-in command offers (a subset of the server's SN_AUTH). */
export type SignInMethod = "basic" | "apikey" | "oauth" | "token";

/**
 * What the sign-in command stores in SecretStorage. It is never written to the
 * settings or to disk by the extension; it reaches the server only through the
 * spawned process environment.
 */
export interface StoredCredentials {
  instance: string;
  method: SignInMethod;
  /** Basic: the user name. */
  user?: string;
  /** OAuth client credentials: the client id. */
  clientId?: string;
  /** Password, API key, OAuth client secret or bearer token (by method). */
  secret: string;
}

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  "basic",
  "apikey",
  "oauth",
  "token",
];

/** Context the env-file path is expanded against. */
export interface PathContext {
  home: string;
  /** First workspace folder, when a folder is open. */
  workspaceFolder?: string;
}

/** Read the raw settings object into a typed, defaulted `ExtensionSettings`. */
export function normalizeSettings(raw: {
  envFile?: unknown;
  packages?: unknown;
  transport?: unknown;
}): ExtensionSettings {
  const envFile = typeof raw.envFile === "string" ? raw.envFile.trim() : "";
  const packages = Array.isArray(raw.packages)
    ? [
        ...new Set(
          raw.packages
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.trim().toLowerCase())
            .filter((p) => p.length > 0),
        ),
      ]
    : typeof raw.packages === "string"
      ? normalizeSettings({ packages: raw.packages.split(/[\s,]+/) }).packages
      : [];
  const transport: Transport = raw.transport === "http" ? "http" : "stdio";
  return { envFile, packages, transport };
}

/**
 * Expand `~`, `${userHome}` and `${workspaceFolder}` in the env-file setting;
 * a relative path resolves against the workspace folder (or the home
 * directory when no folder is open). Returns `undefined` for an empty setting
 * or when `${workspaceFolder}` is used without an open folder.
 */
export function expandEnvFilePath(
  value: string,
  ctx: PathContext,
): string | undefined {
  let path = value.trim();
  if (!path) return undefined;
  if (path.includes("${workspaceFolder}")) {
    if (!ctx.workspaceFolder) return undefined;
    path = path.split("${workspaceFolder}").join(ctx.workspaceFolder);
  }
  path = path.split("${userHome}").join(ctx.home);
  if (path === "~") path = ctx.home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) {
    path = join(ctx.home, path.slice(2));
  }
  if (!isAbsolute(path)) path = resolve(ctx.workspaceFolder ?? ctx.home, path);
  return path;
}

/**
 * The environment the settings contribute (no secrets): `SN_ENV_FILE`,
 * `SN_TOOL_PACKAGES` and, for http, nothing yet — the http launcher adds its
 * own bind variables. Empty settings contribute nothing, so the server keeps
 * its own defaults.
 */
export function settingsEnv(
  settings: ExtensionSettings,
  ctx: PathContext,
): Record<string, string> {
  const env: Record<string, string> = {};
  const envFile = expandEnvFilePath(settings.envFile, ctx);
  if (envFile) env.SN_ENV_FILE = envFile;
  if (settings.packages.length > 0) {
    env.SN_TOOL_PACKAGES = settings.packages.join(",");
  }
  return env;
}

/**
 * The environment signed-in credentials contribute. Process environment wins
 * over the env file in the server (`process.loadEnvFile` never overrides a
 * variable that is already set), so these values take precedence over
 * whatever the file holds. `SN_AUTH` is always explicit (the server would
 * otherwise auto-detect from keys the file may still hold),
 * and `SN_ACTIVE_PROFILE=default` pins the profile the keys belong to.
 */
export function credentialsEnv(
  creds: StoredCredentials,
): Record<string, string> {
  const env: Record<string, string> = {
    SN_INSTANCE: creds.instance,
    SN_ACTIVE_PROFILE: "default",
    SN_AUTH: creds.method,
  };
  switch (creds.method) {
    case "basic":
      env.SN_USER = creds.user ?? "";
      env.SN_PASSWORD = creds.secret;
      break;
    case "apikey":
      env.SN_API_KEY = creds.secret;
      break;
    case "oauth":
      env.SN_OAUTH_GRANT = "client_credentials";
      env.SN_OAUTH_CLIENT_ID = creds.clientId ?? "";
      env.SN_OAUTH_CLIENT_SECRET = creds.secret;
      break;
    case "token":
      env.SN_BEARER_TOKEN = creds.secret;
      break;
  }
  return env;
}

/** The full server environment: settings first, credentials on top. */
export function buildServerEnv(
  settings: ExtensionSettings,
  ctx: PathContext,
  creds: StoredCredentials | undefined,
): Record<string, string> {
  return {
    ...settingsEnv(settings, ctx),
    ...(creds ? credentialsEnv(creds) : {}),
  };
}

/** Parse the SecretStorage value; anything malformed counts as signed out. */
export function parseStoredCredentials(
  raw: string | undefined,
): StoredCredentials | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const method = v.method;
  if (
    typeof v.instance !== "string" ||
    !v.instance.trim() ||
    typeof v.secret !== "string" ||
    !v.secret ||
    typeof method !== "string" ||
    !(SIGN_IN_METHODS as readonly string[]).includes(method)
  ) {
    return undefined;
  }
  const creds: StoredCredentials = {
    instance: v.instance.trim(),
    method: method as SignInMethod,
    secret: v.secret,
  };
  if (creds.method === "basic") {
    if (typeof v.user !== "string" || !v.user.trim()) return undefined;
    creds.user = v.user.trim();
  }
  if (creds.method === "oauth") {
    if (typeof v.clientId !== "string" || !v.clientId.trim()) return undefined;
    creds.clientId = v.clientId.trim();
  }
  return creds;
}

/**
 * Validate an instance entered at sign-in. Accepts what the server accepts —
 * a bare name (`dev12345`), a host or an https URL; returns an error message
 * or `undefined` when acceptable.
 */
export function validateInstance(value: string): string | undefined {
  const v = value.trim();
  if (!v) return "Enter the instance name, host or URL.";
  if (/\s/.test(v)) return "The instance must not contain spaces.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/^https:\/\//i.test(v)) {
    return "Only https:// instance URLs are supported.";
  }
  return undefined;
}

/** A one-line, secret-free description of the signed-in identity. */
export function describeCredentials(creds: StoredCredentials): string {
  const who =
    creds.method === "basic"
      ? ` as ${creds.user}`
      : creds.method === "oauth"
        ? ` (OAuth client ${creds.clientId})`
        : creds.method === "apikey"
          ? " (API key)"
          : " (bearer token)";
  return `${creds.instance}${who}`;
}

/**
 * The definition version VS Code compares to notice a changed server: the
 * settings plus a secret-free credential fingerprint and a sign-in revision
 * (so re-entering a secret for the same identity still counts as a change).
 */
export function definitionVersion(
  settings: ExtensionSettings,
  creds: StoredCredentials | undefined,
  revision: number,
): string {
  const parts = [
    settings.transport,
    settings.envFile,
    settings.packages.join(","),
    creds ? `${creds.method}:${creds.instance}` : "signed-out",
    String(revision),
  ];
  let hash = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
