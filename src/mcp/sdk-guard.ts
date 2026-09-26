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
import { assertTableWriteAllowed } from "../core/policy.js";

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

/**
 * The scopes a write touches: the one named in the written values (a create,
 * or an update that moves the record) and the record's current one.
 */
async function scopesOf(target: SdkGuardTarget): Promise<ScopeRef[]> {
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
  }
  return refs;
}

/**
 * Check one write target. Returns the `sdkManaged` detail to attach (plan or
 * applied result), or undefined when the target is not SDK-managed / the
 * guard is off. In `deny` mode an apply throws SDK_MANAGED_SCOPE.
 */
export async function sdkGuard(
  target: SdkGuardTarget,
  phase: "plan" | "apply",
): Promise<{ sdkManaged: Record<string, unknown> } | undefined> {
  if (!configured()) return undefined;
  // The table policy (H-11) decides first; the guard never judges a write
  // the policy would refuse anyway.
  if (phase === "apply") assertTableWriteAllowed(target.table);
  let result;
  for (const ref of await scopesOf(target)) {
    const r = await detectSdkManaged(ref, { lookup: true });
    if (r.managed === "yes") {
      result = r;
      break;
    }
  }
  if (!result) return undefined;
  const mode = getSdkManagedWrites();
  const scope = result.scope ?? result.sysId ?? "?";
  const message = `Table ${target.table} record${target.sys_id ? ` ${target.sys_id}` : ""} belongs to scope ${scope}, which is SDK-managed.`;
  const detail = {
    scope: result.scope,
    sys_scope: result.sysId,
    mode,
    message,
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
