/**
 * The package policy (A2-1): package names, the named profiles and the
 * SN_TOOL_PACKAGES / deny / read-only resolution. It holds names only, so the
 * status payload can read the policy without loading the tool specs;
 * registry.ts checks at load that {@link ALL_PACKAGES} matches its manifest
 * (E-7: no registry ↔ status import cycle).
 */
import {
  getRequestedPackages,
  getDeniedPackages,
  getReadOnlyPackages,
} from "../core/settings.js";
import { logger } from "../core/logging.js";

/**
 * Canonical package set, in manifest order (admin is the always-on
 * management surface, not a package).
 */
export const ALL_PACKAGES: string[] = [
  "table",
  "schema",
  "aggregate",
  "attachment",
  "importset",
  "batch",
  "catalog",
  "change",
  "knowledge",
  "cmdb",
  "scripts",
  "flows",
  "codecheck",
  "docs",
  "instance",
  "email",
  "atf",
  "revert",
  "artifacts",
  "updatesets",
  "ops",
  "history",
  "properties",
  "directory",
  "ui",
];

/** The default package set when SN_TOOL_PACKAGES is unset or unusable. */
const CORE_PROFILE = ["table", "schema", "aggregate", "attachment"];

/**
 * The read-first surface: browse data and inspect schema without any write or
 * scripting tools. The base for the `developer` preset.
 */
const READER_PROFILE = ["table", "schema", "aggregate"];

/**
 * The developer surface: the reader set plus the build/inspect packages —
 * scripts, flows, code check, and the docs/diagram generators. (There is no
 * separate `diagrams` package; the Mermaid generators live in `docs` and
 * `scripts`.)
 */
const DEVELOPER_PROFILE = [
  ...READER_PROFILE,
  "scripts",
  "flows",
  "codecheck",
  "docs",
];

/**
 * Named profiles that expand to a set of packages, resolved by
 * {@link resolveEnabledPackages}. `core` is the default profile loaded when
 * SN_TOOL_PACKAGES is unset; `all` (and its `admin` alias) enables everything.
 * The `reader` / `developer` / `admin` presets (UX review §11) give clients a
 * memorable name for the common surfaces instead of a hand-typed package list;
 * a preset may still be combined with explicit packages in SN_TOOL_PACKAGES.
 */
const PROFILES: Record<string, string[]> = {
  core: CORE_PROFILE,
  all: ALL_PACKAGES,
  reader: READER_PROFILE,
  developer: DEVELOPER_PROFILE,
  admin: ALL_PACKAGES,
};

/**
 * Resolve requested package/profile names into a concrete package set.
 * Unknown names are ignored (with a warning); an empty result falls back to
 * the `core` profile so the server always exposes a usable tool set.
 */
export function resolveEnabledPackages(requested: string[]): Set<string> {
  const enabled = new Set<string>();
  for (const name of requested) {
    const profile = PROFILES[name];
    if (profile) {
      for (const p of profile) enabled.add(p);
    } else if (ALL_PACKAGES.includes(name)) {
      enabled.add(name);
    } else {
      logger.warn("Unknown tool package ignored", { package: name });
    }
  }
  if (enabled.size === 0) {
    for (const p of CORE_PROFILE) enabled.add(p);
  }
  return enabled;
}

/** The package policy currently in effect (also shown in the status payload). */
export function effectivePackages(): {
  enabled: string[];
  denied: string[];
  readOnly: string[];
} {
  const denied = new Set(getDeniedPackages());
  const enabled = [...resolveEnabledPackages(getRequestedPackages())].filter(
    (p) => !denied.has(p),
  );
  return {
    enabled: enabled.sort(),
    denied: [...denied].sort(),
    readOnly: getReadOnlyPackages().sort(),
  };
}
