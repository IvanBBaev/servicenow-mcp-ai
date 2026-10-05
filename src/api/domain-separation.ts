import { snString } from "./shared.js";

/**
 * N-12 (NX-16) — domain separation awareness.
 *
 * On a domain-separated (MSP) instance every record carries the domain it
 * belongs to (`sys_domain`) and a domain-specific copy of a script or rule
 * points at the record it overrides (`sys_overrides`). Reads run in the
 * session user's domain, so the tools must say which domain a record came
 * from instead of describing it as if it applied everywhere.
 *
 * The helpers here are additive by construction: on an instance without
 * domain separation the fields are absent from every response, so nothing is
 * attributed and the output stays byte-identical.
 *
 * Unverified until O-5 (PDI): `sys_overrides` and the `sys_domain.name`
 * dot-walk are not read by any other code yet, and whether a non-separated
 * instance returns an empty `sys_domain` instead of omitting it is not
 * confirmed. `sys_domain` itself is already in the Fluent ignore list.
 */

/** Fields a list read requests so a record can be attributed to its domain. */
export const DOMAIN_FIELDS = ["sys_domain", "sys_overrides"] as const;

/**
 * Fields a trace lane requests to attribute an entry to its domain, read
 * through `prefix` (a reference dot-walk) when given.
 */
export function domainTraceFields(prefix = ""): string[] {
  return [
    `${prefix}sys_domain`,
    `${prefix}sys_domain.name`,
    `${prefix}sys_overrides`,
  ];
}

/** The sys_id (and default name) of the top-level domain. */
export const GLOBAL_DOMAIN = "global";

/**
 * The one caveat line a result carries when it attributed at least one
 * record to a domain: the view is the session user's domain, not every one.
 */
export const DOMAIN_CAVEAT =
  "Domain separation: entries carrying 'domain' belong to that domain only. Reads run in this user's domain (and its visible parents), so rules of other domains are not shown.";

/** One record's domain attribution; empty when the record is not domain-specific. */
export interface RecordDomain {
  /** Domain name (or sys_id when only that was read), never `global`. */
  domain?: string;
  /** sys_id of the record this one overrides in its domain. */
  overrides?: string;
}

/**
 * The domain attribution of a row: the domain when it is set and not the
 * global one, and the overridden record when there is one. A row read with
 * `sysparm_display_value=all` prefers the display value; a `sys_domain.name`
 * dot-walk wins over a bare sys_id. `prefix` reads the fields through a
 * reference (e.g. `flow.` on a trigger row: the flow's domain, not the
 * trigger's).
 */
export function recordDomain(
  row: Record<string, unknown>,
  prefix = "",
): RecordDomain {
  const raw = row[`${prefix}sys_domain`];
  const display =
    raw && typeof raw === "object" && "display_value" in raw
      ? snString((raw as { display_value?: unknown }).display_value)
      : "";
  const value = snString(raw);
  const name = snString(row[`${prefix}sys_domain.name`]);
  const domain = name || display || value;
  const overrides = snString(row[`${prefix}sys_overrides`]);
  const out: RecordDomain = {};
  const isGlobal = [value, domain].some(
    (v) => v.toLowerCase() === GLOBAL_DOMAIN,
  );
  if (domain && !isGlobal) out.domain = domain;
  if (overrides) out.overrides = overrides;
  return out;
}

/**
 * Copy the domain fields a row carries onto `target`, unchanged, when the row
 * has them (list reads keep `sys_domain` / `sys_overrides` as returned).
 */
export function keepDomainFields(
  row: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const f of DOMAIN_FIELDS) {
    if (f in row && !(f in target)) target[f] = row[f];
  }
}
