import { ServiceNowError } from "../core/errors.js";
import {
  getSdkManagedScopes,
  getSdkManagedWrites,
  getSdkProjectDirs,
} from "../core/settings.js";
import {
  detectSdkManaged,
  type ScopeRef,
} from "../core/artifacts/sdk-managed.js";
import { getRecord } from "../api/table.js";
import { getTableChain } from "../api/meta.js";
import { readUserPreference } from "../api/updatesets.js";
import { assertTableWriteAllowed } from "../core/policy.js";
import { currentCall, type CallContext } from "../core/request-context.js";

/**
 * P-22 — the SDK-managed write guard. A record whose scope is SDK-managed
 * (P-3: declared in SN_SDK_MANAGED_SCOPES or found in a now.config.json under
 * SN_SDK_PROJECT_DIRS) is owned by a ServiceNow SDK project: an edit on the
 * instance is overwritten by the next `now-sdk install`. The guard runs after
 * the table policy (H-11) — the tools call it once the write is known to be
 * permitted — and, per SN_SDK_MANAGED_WRITES:
 * - `warn` (default): the plan and the applied result carry `sdkManaged`;
 * - `deny`: the plan says `would_refuse`, the apply fails SDK_MANAGED_SCOPE;
 * - `allow`: nothing.
 * It costs nothing unless detection is configured, and reads only the
 * record's `sys_scope` (a table without the field is never SDK-managed).
 *
 * A create that names no `sys_scope` lands in the session user's current
 * application: for a table that extends `sys_metadata` the guard reads the
 * user's `apps.current_app` preference (no row = `global`, never
 * SDK-managed). The preference name and its sys_id value are unverified on a
 * live instance (O-5). When the scope cannot be read the guard degrades: the
 * result carries `sdkScopeWarning` and the write is judged unscoped — it
 * never fails the call.
 */

/** The Fluent alternative the plan names. */
export const SDK_ALTERNATIVE =
  "Change the source in the scope's ServiceNow SDK (Fluent) project and run `now-sdk install`; an instance-side edit is overwritten by the next install.";

export interface SdkGuardTarget {
  table: string;
  /** The record written (update / delete / an upsert update). */
  sys_id?: string;
  /** The values written; a `sys_scope` among them names the scope of a create. */
  fields?: Record<string, unknown>;
  /** A record already read, when it carries `sys_scope`. */
  record?: unknown;
}

/** `sys_scope` as a string sys_id, a `{value, display_value}` pair or a link. */
export function scopeRefOf(value: unknown): ScopeRef | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v
      ? /^[0-9a-f]{32}$/i.test(v)
        ? { sys_id: v }
        : { scope: v }
      : null;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const id = typeof o.value === "string" && o.value ? o.value : null;
    const name =
      typeof o.display_value === "string" &&
      o.display_value &&
      !/^[0-9a-f]{32}$/i.test(o.display_value)
        ? o.display_value
        : null;
    if (id || name) return { sys_id: id, scope: name };
  }
  return null;
}

function configured(): boolean {
  return (
    getSdkManagedWrites() !== "allow" &&
    (getSdkManagedScopes().length > 0 || getSdkProjectDirs().length > 0)
  );
}

/** The user preference that holds the session's current application. */
export const CURRENT_APP_PREFERENCE = "apps.current_app";

type CurrentScope =
  | { ref: ScopeRef | null; source: "current_application" | "default" }
  | { warning: string };

/** One current-scope read per tool call, however many records it writes. */
const currentScopeByCall = new WeakMap<CallContext, Promise<CurrentScope>>();

function isCancel(e: unknown): boolean {
  return e instanceof ServiceNowError && e.code === "CANCELLED";
}

async function readCurrentScope(): Promise<CurrentScope> {
  try {
    const row = await readUserPreference(CURRENT_APP_PREFERENCE);
    const ref = scopeRefOf(row?.value);
    return ref
      ? { ref, source: "current_application" }
      : { ref: null, source: "default" };
  } catch (e) {
    if (isCancel(e)) throw e;
    return {
      warning: `Could not read the session's current application (${CURRENT_APP_PREFERENCE}: ${
        e instanceof Error ? e.message : String(e)
      }); the SDK-managed check judged the create without a scope.`,
    };
  }
}

function currentScope(): Promise<CurrentScope> {
  const call = currentCall();
  if (!call) return readCurrentScope();
  let pending = currentScopeByCall.get(call);
  if (!pending) {
    pending = readCurrentScope();
    currentScopeByCall.set(call, pending);
  }
  return pending;
}

/**
 * The scope a create without `sys_scope` lands in: only tables under
 * `sys_metadata` carry one. Undefined = nothing to judge.
 */
async function createScope(
  table: string,
): Promise<{ ref?: ScopeRef; warning?: string }> {
  let chain: string[];
  try {
    chain = await getTableChain(table);
  } catch (e) {
    if (isCancel(e)) throw e;
    return {
      warning: `Could not read the hierarchy of ${table} to resolve the scope of the create; the SDK-managed check judged it without a scope.`,
    };
  }
  if (!chain.includes("sys_metadata")) return {};
  const current = await currentScope();
  if ("warning" in current) return { warning: current.warning };
  return current.ref ? { ref: current.ref } : {};
}

/**
 * The scopes a write touches: the one named in the written values (a create,
 * or an update that moves the record) and the record's current one; for a
 * create that names none, the session's current application.
 */
async function scopesOf(
  target: SdkGuardTarget,
): Promise<{ refs: ScopeRef[]; warning?: string; currentApp?: ScopeRef }> {
  const refs: ScopeRef[] = [];
  const fromFields = scopeRefOf(target.fields?.sys_scope);
  if (fromFields) refs.push(fromFields);
  const fromRecord =
    target.record && typeof target.record === "object"
      ? scopeRefOf((target.record as Record<string, unknown>).sys_scope)
      : null;
  if (fromRecord) refs.push(fromRecord);
  else if (target.sys_id) {
    try {
      const rec = await getRecord(target.table, target.sys_id, ["sys_scope"]);
      const current = scopeRefOf(rec.sys_scope);
      if (current) refs.push(current);
    } catch {
      // The write itself reports a missing record or an ACL; the guard has
      // no scope to judge.
    }
  } else if (!fromFields) {
    const created = await createScope(target.table);
    if (created.ref) {
      refs.push(created.ref);
      return { refs, currentApp: created.ref };
    }
    if (created.warning) return { refs, warning: created.warning };
  }
  return { refs };
}

/**
 * Check one write target. Returns the `sdkManaged` detail to attach (plan or
 * applied result), or undefined when the target is not SDK-managed / the
 * guard is off. In `deny` mode an apply throws SDK_MANAGED_SCOPE.
 */
export async function sdkGuard(
  target: SdkGuardTarget,
  phase: "plan" | "apply",
): Promise<
  { sdkManaged?: Record<string, unknown>; sdkScopeWarning?: string } | undefined
> {
  if (!configured()) return undefined;
  // The table policy (H-11) decides first; the guard never judges a write
  // the policy would refuse anyway.
  if (phase === "apply") assertTableWriteAllowed(target.table);
  let result;
  let fromCurrentApp = false;
  const { refs, warning, currentApp } = await scopesOf(target);
  for (const ref of refs) {
    const r = await detectSdkManaged(ref, { lookup: true });
    if (r.managed === "yes") {
      result = r;
      fromCurrentApp = ref === currentApp;
      break;
    }
  }
  if (!result) return warning ? { sdkScopeWarning: warning } : undefined;
  const mode = getSdkManagedWrites();
  const scope = result.scope ?? result.sysId ?? "?";
  const message = `Table ${target.table} record${target.sys_id ? ` ${target.sys_id}` : ""} belongs to scope ${scope}, which is SDK-managed.`;
  const detail = {
    scope: result.scope,
    sys_scope: result.sysId,
    mode,
    message,
    ...(fromCurrentApp ? { scope_source: "current_application" } : {}),
    alternative: SDK_ALTERNATIVE,
    evidence: result.evidence
      .filter((e) => e.matched)
      .map((e) => ({
        source: e.source,
        verified: e.verified,
        detail: e.detail,
      })),
    ...(mode === "deny" ? { would_refuse: true } : {}),
  };
  if (mode === "deny" && phase === "apply") {
    throw new ServiceNowError(
      `${message} SN_SDK_MANAGED_WRITES=deny refuses instance-side writes there. Nothing was changed.`,
      409,
      detail,
      { code: "SDK_MANAGED_SCOPE", hint: SDK_ALTERNATIVE },
    );
  }
  return { sdkManaged: detail };
}
