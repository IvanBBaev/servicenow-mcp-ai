import fs from "node:fs";
import path from "node:path";

import { getSdkManagedScopes, getSdkProjectDirs } from "../settings.js";
import { currentRuntime, defineRuntimePart } from "../runtime.js";
import { snRequest } from "../http.js";
import { assertTableAllowed } from "../policy.js";

/**
 * P-3 — SDK-managed scope detection.
 *
 * An application scope is "SDK-managed" when its source of truth is a local
 * ServiceNow SDK (Fluent) project rather than the instance: editing its records
 * on the instance is overwritten by the next `now-sdk install`. This module
 * answers `yes` / `no` / `unknown` for one scope and says why.
 *
 * Authority order — the documented default, pending owner gate O-6:
 *
 * 1. The owner's declaration, `SN_SDK_MANAGED_SCOPES` (scope names or
 *    `sys_scope` sys_ids).
 * 2. `now.config.json` files under `SN_SDK_PROJECT_DIRS` whose `scope` /
 *    `scopeId` match the `sys_scope` record.
 * 3. Instance heuristics — **unverified and advisory** (pending O-5). They can
 *    raise `unknown` to `yes` but never produce `no`, and every piece of
 *    heuristic evidence carries `verified: false`.
 *
 * `no` is returned only when at least one of sources 1–2 is configured, was
 * read completely, can be compared with the scope's identity and does not
 * match; otherwise the answer is `unknown`.
 *
 * The filesystem scan is bounded (depth, directories, config files, file size),
 * never follows a symbolic link and reads only files named `now.config.json`.
 * The write guard that consumes this answer is P-22, not implemented here.
 */

export type SdkManaged = "yes" | "no" | "unknown";

/** One piece of evidence behind a verdict. */
export interface SdkManagedEvidence {
  source: "declaration" | "now.config.json" | "heuristic";
  /** Whether this source matched the scope. */
  matched: boolean;
  /**
   * `false` for instance heuristics until O-5 confirms one; the deterministic
   * sources (1–2) are `true`.
   */
  verified: boolean;
  detail: string;
  /** The `now.config.json` file, for source 2. */
  path?: string;
  /** The heuristic id, for source 3. */
  heuristic?: string;
}

export interface SdkManagedResult {
  /** Scope namespace (`x_acme_app`), when known. */
  scope: string | null;
  /** `sys_scope` sys_id, when known. */
  sysId: string | null;
  managed: SdkManaged;
  /** True when the verdict rests on an unverified instance heuristic. */
  unverified: boolean;
  evidence: SdkManagedEvidence[];
  warnings: string[];
  /** The authority order applied (the O-6 default). */
  authority: string;
}

/** A `sys_scope` identity: at least one of the two keys. */
export interface ScopeRef {
  scope?: string | null;
  sys_id?: string | null;
}

/**
 * An instance heuristic (source 3). It returns `raised: true` when it sees a
 * marker suggesting the scope is SDK-managed; `null` or `raised: false` when
 * it has no opinion. It can never make the answer `no`.
 */
export interface SdkHeuristic {
  id: string;
  description: string;
  run(ref: {
    scope: string | null;
    sysId: string | null;
  }): Promise<{ raised: boolean; detail: string } | null>;
}

export interface DetectOptions {
  /**
   * Resolve the missing half of the scope identity (name ↔ sys_id) from the
   * instance's `sys_scope` table. Off by default: detection is then purely
   * local unless heuristics are passed.
   */
  lookup?: boolean;
  /** Custom resolver (tests, or a caller that already holds the record). */
  resolveScope?: (ref: ScopeRef) => Promise<ScopeRef | null>;
  /** Instance heuristics to consult (default {@link DEFAULT_SDK_HEURISTICS}). */
  heuristics?: readonly SdkHeuristic[];
}

export const SDK_AUTHORITY_ORDER =
  "declaration (SN_SDK_MANAGED_SCOPES) > now.config.json (SN_SDK_PROJECT_DIRS) > instance heuristics (unverified); default pending O-6";

/**
 * Instance heuristics shipped by default: none. Candidate markers (SDK
 * install history, `sys_app` / `sys_metadata` markers left by `now-sdk
 * install`) have not been confirmed on a live instance (O-5), so none is on
 * by default; callers may pass their own through {@link DetectOptions}.
 */
export const DEFAULT_SDK_HEURISTICS: readonly SdkHeuristic[] = [];

/** Scan bounds for `SN_SDK_PROJECT_DIRS`. */
export const SDK_SCAN_LIMITS = {
  /** Directory levels below each root (the root is depth 0). */
  maxDepth: 4,
  /** Directories visited across all roots. */
  maxDirs: 2000,
  /** `now.config.json` files read across all roots. */
  maxConfigs: 100,
  /** Largest `now.config.json` read, in bytes. */
  maxFileBytes: 256 * 1024,
};

export type SdkScanLimits = typeof SDK_SCAN_LIMITS;

/** Scan results are reused for this long (the files rarely change). */
export const SDK_SCAN_TTL_MS = 60_000;

const CONFIG_FILE = "now.config.json";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "out"]);
const SYS_ID = /^[0-9a-f]{32}$/i;
const SCOPE_NAME = /^[a-z0-9_]+$/;

/** One SDK project found on disk. */
export interface SdkProject {
  /** Absolute path of the `now.config.json`. */
  path: string;
  /** `scope` from the file, lower-cased; null when absent or not a string. */
  scope: string | null;
  /** `scopeId` from the file, lower-cased; null when absent or not a string. */
  scopeId: string | null;
}

export interface SdkProjectScan {
  roots: string[];
  projects: SdkProject[];
  /** Unreadable roots, invalid or oversized config files. */
  warnings: string[];
  /** A scan limit was hit: the project list may be incomplete. */
  truncated: boolean;
}

interface CachedScan {
  at: number;
  scan: SdkProjectScan;
}

// E-3: the per-process scan cache is a runtime part.
const scanCachePart = defineRuntimePart(
  "sdkProjectScan",
  () => new Map<string, CachedScan>(),
  (cache) => cache.clear(),
  { scope: "process" },
);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;

/**
 * Walk `roots` for `now.config.json` files within {@link SDK_SCAN_LIMITS}.
 * Symbolic links are never followed (neither directories nor files), hidden
 * directories and build/dependency folders are skipped, and only regular
 * files named exactly `now.config.json` are opened.
 */
export function scanSdkProjects(
  roots: readonly string[],
  limits: SdkScanLimits = SDK_SCAN_LIMITS,
): SdkProjectScan {
  const result: SdkProjectScan = {
    roots: [...roots],
    projects: [],
    warnings: [],
    truncated: false,
  };
  let dirs = 0;
  let configs = 0;

  const readConfig = (file: string): void => {
    if (configs >= limits.maxConfigs) {
      result.truncated = true;
      return;
    }
    configs++;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return;
      if (st.size > limits.maxFileBytes) {
        result.warnings.push(
          `${file}: larger than ${limits.maxFileBytes} bytes, skipped`,
        );
        return;
      }
      const json: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const obj = (json ?? {}) as Record<string, unknown>;
      const project = {
        path: file,
        scope: str(obj.scope),
        scopeId: str(obj.scopeId),
      };
      if (project.scope === null && project.scopeId === null) {
        result.warnings.push(`${file}: no scope or scopeId`);
        return;
      }
      result.projects.push(project);
    } catch (error) {
      result.warnings.push(`${file}: ${(error as Error).message}`);
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (result.truncated) return;
    if (dirs >= limits.maxDirs) {
      result.truncated = true;
      return;
    }
    dirs++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      result.warnings.push(`${dir}: ${(error as Error).message}`);
      return;
    }
    const config = entries.find((e) => e.name === CONFIG_FILE && e.isFile());
    if (config) readConfig(path.join(dir, CONFIG_FILE));
    if (depth >= limits.maxDepth) return;
    for (const e of entries) {
      // Dirent types come from lstat semantics: a symlink is never a directory.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
      if (result.truncated) return;
    }
  };

  for (const root of roots) {
    let real: string;
    try {
      // The operator names the root; resolve it once so the walk below (which
      // never follows links) stays inside it.
      real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) {
        result.warnings.push(`${root}: not a directory`);
        continue;
      }
    } catch (error) {
      result.warnings.push(`${root}: ${(error as Error).message}`);
      continue;
    }
    walk(real, 0);
    if (result.truncated) break;
  }
  return result;
}

/** The cached scan of `SN_SDK_PROJECT_DIRS` (empty when unset). */
export function sdkProjectScan(now: number = Date.now()): SdkProjectScan {
  const roots = getSdkProjectDirs();
  if (roots.length === 0) {
    return { roots: [], projects: [], warnings: [], truncated: false };
  }
  const cache = currentRuntime().get(scanCachePart);
  const key = roots.join("\0");
  const hit = cache.get(key);
  if (hit && now - hit.at < SDK_SCAN_TTL_MS) return hit.scan;
  const scan = scanSdkProjects(roots);
  cache.set(key, { at: now, scan });
  return scan;
}

/** Drop the cached scan (the next read rescans). */
export function clearSdkProjectScan(): void {
  currentRuntime().get(scanCachePart).clear();
}

/** Look the missing half of a scope identity up in `sys_scope`. */
async function lookupScope(ref: ScopeRef): Promise<ScopeRef | null> {
  // Only plain identifiers reach the encoded query (no `^` / operator injection).
  const key = ref.sys_id ?? ref.scope ?? "";
  if (!SCOPE_NAME.test(key)) return null;
  assertTableAllowed("sys_scope");
  const query = ref.sys_id ? `sys_id=${ref.sys_id}` : `scope=${ref.scope}`;
  const { data } = await snRequest<{ result?: Array<Record<string, unknown>> }>(
    {
      method: "GET",
      path: "/api/now/table/sys_scope",
      params: new URLSearchParams({
        sysparm_query: query,
        sysparm_fields: "sys_id,scope",
        sysparm_limit: "1",
      }),
    },
  );
  const row = data?.result?.[0];
  if (!row) return null;
  return { scope: str(row.scope), sys_id: str(row.sys_id) };
}

function normalizeRef(input: string | ScopeRef): {
  scope: string | null;
  sysId: string | null;
} {
  if (typeof input === "string") {
    const v = str(input);
    return v !== null && SYS_ID.test(v)
      ? { scope: null, sysId: v }
      : { scope: v, sysId: null };
  }
  return { scope: str(input.scope), sysId: str(input.sys_id) };
}

/**
 * Is `scope` (a namespace, a `sys_scope` sys_id, or a `{scope, sys_id}`
 * record) SDK-managed? See the module comment for the authority order.
 */
export async function detectSdkManaged(
  input: string | ScopeRef,
  opts: DetectOptions = {},
): Promise<SdkManagedResult> {
  let { scope, sysId } = normalizeRef(input);
  const evidence: SdkManagedEvidence[] = [];
  const warnings: string[] = [];

  if (
    (scope === null || sysId === null) &&
    (scope !== null || sysId !== null)
  ) {
    const resolver =
      opts.resolveScope ?? (opts.lookup ? lookupScope : undefined);
    if (resolver) {
      try {
        const found = await resolver({ scope, sys_id: sysId });
        if (found) {
          scope ??= str(found.scope);
          sysId ??= str(found.sys_id);
        } else {
          warnings.push("sys_scope record not found; identity is incomplete");
        }
      } catch (error) {
        warnings.push(`sys_scope lookup failed: ${(error as Error).message}`);
      }
    }
  }

  // Whether every configured deterministic entry could be compared with the
  // identity we hold — otherwise a non-match proves nothing.
  let comparable = true;
  let matched = false;

  // Source 1 — the owner's declaration.
  const declared = getSdkManagedScopes();
  for (const entry of declared) {
    const bySysId = SYS_ID.test(entry);
    const key = bySysId ? sysId : scope;
    if (key === null) {
      comparable = false;
      continue;
    }
    if (entry === key) {
      matched = true;
      evidence.push({
        source: "declaration",
        matched: true,
        verified: true,
        detail: `SN_SDK_MANAGED_SCOPES lists ${bySysId ? "sys_id" : "scope"} ${entry}`,
      });
    }
  }
  if (
    declared.length > 0 &&
    !evidence.some((e) => e.source === "declaration")
  ) {
    evidence.push({
      source: "declaration",
      matched: false,
      verified: true,
      detail: `not among the ${declared.length} scope(s) in SN_SDK_MANAGED_SCOPES`,
    });
  }

  // Source 2 — now.config.json files.
  const scan = sdkProjectScan();
  const scanComplete =
    scan.roots.length > 0 && !scan.truncated && scan.warnings.length === 0;
  if (scan.truncated) {
    warnings.push(
      "SN_SDK_PROJECT_DIRS scan hit a limit; the project list is partial",
    );
  }
  for (const w of scan.warnings) warnings.push(`SN_SDK_PROJECT_DIRS: ${w}`);
  let projectMatch = false;
  for (const p of scan.projects) {
    const idMatch = p.scopeId !== null && sysId !== null && p.scopeId === sysId;
    const idConflict =
      p.scopeId !== null && sysId !== null && p.scopeId !== sysId;
    const nameMatch = p.scope !== null && scope !== null && p.scope === scope;
    if (idMatch || (nameMatch && !idConflict)) {
      matched = projectMatch = true;
      evidence.push({
        source: "now.config.json",
        matched: true,
        verified: true,
        path: p.path,
        detail: idMatch
          ? `scopeId ${p.scopeId} matches the sys_scope record`
          : `scope ${p.scope} matches`,
      });
      continue;
    }
    if (nameMatch && idConflict) {
      evidence.push({
        source: "now.config.json",
        matched: false,
        verified: true,
        path: p.path,
        detail: `scope ${p.scope} matches but scopeId ${p.scopeId} differs from the sys_scope record ${sysId}`,
      });
    }
    const canCompare =
      (p.scopeId !== null && sysId !== null) ||
      (p.scope !== null && scope !== null);
    if (!canCompare) comparable = false;
  }
  if (scan.roots.length > 0 && !projectMatch) {
    evidence.push({
      source: "now.config.json",
      matched: false,
      verified: true,
      detail: `no matching now.config.json among ${scan.projects.length} project(s) under SN_SDK_PROJECT_DIRS`,
    });
  }

  const result = (
    managed: SdkManaged,
    unverified = false,
  ): SdkManagedResult => ({
    scope,
    sysId,
    managed,
    unverified,
    evidence,
    warnings,
    authority: SDK_AUTHORITY_ORDER,
  });

  if (matched) return result("yes");

  // Source 3 — instance heuristics: advisory, never a `no`.
  let raised = false;
  for (const h of opts.heuristics ?? DEFAULT_SDK_HEURISTICS) {
    try {
      const out = await h.run({ scope, sysId });
      if (!out) continue;
      raised ||= out.raised;
      evidence.push({
        source: "heuristic",
        heuristic: h.id,
        matched: out.raised,
        verified: false,
        detail: `unverified heuristic (pending O-5): ${out.detail}`,
      });
    } catch (error) {
      warnings.push(`heuristic ${h.id} failed: ${(error as Error).message}`);
    }
  }

  const conclusive =
    comparable &&
    (declared.length > 0 || scanComplete) &&
    (scope !== null || sysId !== null);
  // Deterministic sources outrank heuristics: a raised heuristic stays evidence.
  if (conclusive) return result("no");
  if (raised) return result("yes", true);
  return result("unknown");
}

/** The status / capabilities view: what the local sources declare. */
export interface SdkManagedStatus {
  authority: string;
  /** `SN_SDK_MANAGED_SCOPES`, normalized. */
  declared: string[];
  /** `SN_SDK_PROJECT_DIRS`, resolved. */
  projectDirs: string[];
  /** Scopes found in `now.config.json` files. */
  projects: SdkProject[];
  /** Every scope (or sys_id) the local sources mark as SDK-managed. */
  scopes: Array<{
    scope: string | null;
    scopeId: string | null;
    sources: string[];
  }>;
  truncated: boolean;
  warnings: string[];
  /** Instance heuristics are not run here (they are unverified; O-5). */
  heuristics: string;
}

/**
 * The SDK-managed scopes the local sources (1–2) declare — no instance call,
 * so it is safe inside `get_status`.
 */
export function sdkManagedStatus(): SdkManagedStatus {
  const declared = getSdkManagedScopes();
  const scan = sdkProjectScan();
  const scopes: SdkManagedStatus["scopes"] = [];
  const find = (scope: string | null, scopeId: string | null) =>
    scopes.find(
      (s) =>
        (scope !== null && s.scope === scope) ||
        (scopeId !== null && s.scopeId === scopeId),
    );
  for (const entry of declared) {
    const bySysId = SYS_ID.test(entry);
    scopes.push({
      scope: bySysId ? null : entry,
      scopeId: bySysId ? entry : null,
      sources: ["declaration"],
    });
  }
  for (const p of scan.projects) {
    const existing = find(p.scope, p.scopeId);
    if (existing) {
      existing.scope ??= p.scope;
      existing.scopeId ??= p.scopeId;
      if (!existing.sources.includes(CONFIG_FILE))
        existing.sources.push(CONFIG_FILE);
    } else {
      scopes.push({
        scope: p.scope,
        scopeId: p.scopeId,
        sources: [CONFIG_FILE],
      });
    }
  }
  return {
    authority: SDK_AUTHORITY_ORDER,
    declared,
    projectDirs: scan.roots,
    projects: scan.projects,
    scopes,
    truncated: scan.truncated,
    warnings: scan.warnings,
    heuristics:
      "not run here; instance heuristics are unverified (pending O-5)",
  };
}
