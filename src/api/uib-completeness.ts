import { queryTable, type SnRecord } from "./table.js";
import { snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";
import {
  BROKER_TABLE_NAMES,
  brokerTable,
  isSysId,
  macroponentUses,
} from "./uib-usage.js";

/**
 * N-28 (UX-09) — the `uib_completeness` block of `get_update_set`: for every
 * UI Builder page an update set touches, which of the records the page needs
 * on the target instance are captured in the set and which are not.
 *
 * A page is anchored on any captured route (sys_ux_app_route), screen
 * (sys_ux_screen_type), variant (sys_ux_screen), macroponent
 * (sys_ux_macroponent) or client script (sys_ux_client_script). For each page
 * variant it expects:
 *
 *   route(s) → screen → variant → applicability → macroponent
 *     → client scripts → data brokers → their `ux_data_broker` ACLs
 *
 * and lists the ones with no sys_update_xml row in the set. A missing record
 * is a prompt, not an error: it may already be on the target (OOB, or shipped
 * by an earlier set) — see `caveats`.
 *
 * Reads are bounded (IN lists chunked, at most `MAX_PAGES` pages, `ROW_LIMIT`
 * rows per read). An unreadable table degrades to an `unavailable` entry;
 * cancellation propagates.
 *
 * Unverified until gate O-5 (a PDI): that a captured record's update name is
 * `<table>_<sys_id>`; the field names `sys_ux_screen.screen_type` /
 * `.macroponent` / `.applicability`, `sys_ux_app_route.screen_type`,
 * `sys_ux_client_script.macroponent`; the broker tables (uib-usage.ts); that a
 * data broker ACL is `type=ux_data_broker` named by the broker sys_id.
 */

/** Pages checked per call; more are reported as `truncated`. */
export const MAX_PAGES = 20;
const IN_CHUNK = 100;
const ROW_LIMIT = 500;
const SYS_ID = /^[0-9a-f]{32}$/;
/** `<table>_<sys_id>` — the update name of a captured record (O-5). */
const UPDATE_NAME = /^(sys_ux_[a-z0-9_]+)_([0-9a-f]{32})$/;

const T = {
  route: "sys_ux_app_route",
  screen: "sys_ux_screen_type",
  variant: "sys_ux_screen",
  macroponent: "sys_ux_macroponent",
  clientScript: "sys_ux_client_script",
  applicability: "sys_ux_applicability",
  acl: "sys_security_acl",
} as const;

export type UibRole =
  | "route"
  | "screen"
  | "variant"
  | "applicability"
  | "macroponent"
  | "client_script"
  | "data_broker"
  | "acl";

export interface UibExpected {
  role: UibRole;
  table: string;
  sys_id: string;
  name?: string;
}

export interface UibPage {
  variant?: { sys_id: string; name?: string };
  macroponent?: { sys_id: string; name?: string };
  /** Records the page needs, counted per role. */
  expected: Partial<Record<UibRole, number>>;
  missing: UibExpected[];
}

export interface UibCompleteness {
  checked: number;
  complete: boolean;
  pages: UibPage[];
  truncated?: boolean;
  unavailable?: { table: string; reason: string }[];
  caveats: string[];
}

interface Ctx {
  unavailable: { table: string; reason: string }[];
  caveats: string[];
}

const str = (row: SnRecord, field: string): string => snString(row[field]);
const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;

function isCancelled(error: unknown): boolean {
  return error instanceof ServiceNowError && error.code === "CANCELLED";
}

async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  prefix?: string,
): Promise<SnRecord[]> {
  const list = [...new Set(ids)].filter((id) => SYS_ID.test(id));
  if (!list.length || ctx.unavailable.some((u) => u.table === table)) {
    return [];
  }
  const out: SnRecord[] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    try {
      const { records, total } = await queryTable({
        table,
        query: `${prefix ? `${prefix}^` : ""}${field}IN${chunk.join(",")}`,
        fields,
        limit: ROW_LIMIT,
        displayValue: "false",
      });
      out.push(...records);
      if (total !== undefined && total > records.length) {
        ctx.caveats.push(
          `${table}: read capped at ${ROW_LIMIT} rows; the check may be incomplete.`,
        );
      }
    } catch (error) {
      if (isCancelled(error)) throw error;
      ctx.unavailable.push({
        table,
        reason: error instanceof Error ? error.message : String(error),
      });
      return out;
    }
  }
  return out;
}

/** UIB records an update set captures, by table, from update names (pure). */
export function uibAnchors(names: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const name of names) {
    const m = UPDATE_NAME.exec(name);
    if (!m) continue;
    const [, table, sysId] = m;
    if (!out.has(table!)) out.set(table!, new Set());
    out.get(table!)!.add(sysId!);
  }
  return out;
}

const groupBy = (rows: SnRecord[], field: string) => {
  const out = new Map<string, SnRecord[]>();
  for (const r of rows) {
    const k = str(r, field);
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
};

/**
 * The `uib_completeness` block for one update set, given the update names
 * the caller read from it. `undefined` when none anchors a UIB page.
 */
export async function uibCompleteness(
  updateSet: string,
  names: Iterable<string>,
  opts: { partial?: boolean } = {},
): Promise<UibCompleteness | undefined> {
  const anchors = uibAnchors(names);
  const get = (t: string) => [...(anchors.get(t) ?? [])];
  if (
    ![T.route, T.screen, T.variant, T.macroponent, T.clientScript].some(
      (t) => anchors.get(t)?.size,
    )
  ) {
    return undefined;
  }
  const ctx: Ctx = { unavailable: [], caveats: [] };
  const VARIANT_FIELDS = [
    "sys_id",
    "name",
    "screen_type",
    "macroponent",
    "applicability",
  ];

  // 1. Anchors → variants (and macroponents with no variant).
  const routeAnchors = await readIn(ctx, T.route, "sys_id", get(T.route), [
    "sys_id",
    "screen_type",
  ]);
  const scriptAnchors = await readIn(
    ctx,
    T.clientScript,
    "sys_id",
    get(T.clientScript),
    ["sys_id", "macroponent"],
  );
  const screenTypes = new Set([
    ...get(T.screen),
    ...routeAnchors.map((r) => str(r, "screen_type")),
  ]);
  const anchorMacroponents = new Set([
    ...get(T.macroponent),
    ...scriptAnchors.map((r) => str(r, "macroponent")),
  ]);
  const variantRows = new Map<string, SnRecord>();
  for (const rows of [
    await readIn(ctx, T.variant, "sys_id", get(T.variant), VARIANT_FIELDS),
    await readIn(ctx, T.variant, "screen_type", screenTypes, VARIANT_FIELDS),
    await readIn(
      ctx,
      T.variant,
      "macroponent",
      anchorMacroponents,
      VARIANT_FIELDS,
    ),
  ]) {
    for (const r of rows) variantRows.set(str(r, "sys_id"), r);
  }
  const variants = [...variantRows.values()];
  const withVariant = new Set(variants.map((v) => str(v, "macroponent")));
  const lone = [...anchorMacroponents].filter(
    (m) => SYS_ID.test(m) && !withVariant.has(m),
  );
  const total = variants.length + lone.length;
  const keptVariants = variants.slice(0, MAX_PAGES);
  const keptLone = lone.slice(0, Math.max(0, MAX_PAGES - keptVariants.length));
  const truncated = total > keptVariants.length + keptLone.length;

  // 2. What those pages need.
  const macroponentIds = new Set([
    ...keptVariants.map((v) => str(v, "macroponent")),
    ...keptLone,
  ]);
  const screenRows = await readIn(
    ctx,
    T.screen,
    "sys_id",
    keptVariants.map((v) => str(v, "screen_type")),
    ["sys_id", "name"],
  );
  const routeRows = await readIn(
    ctx,
    T.route,
    "screen_type",
    keptVariants.map((v) => str(v, "screen_type")),
    ["sys_id", "name", "screen_type"],
  );
  const applicabilityRows = await readIn(
    ctx,
    T.applicability,
    "sys_id",
    keptVariants.map((v) => str(v, "applicability")),
    ["sys_id", "name"],
  );
  const macroponentRows = await readIn(
    ctx,
    T.macroponent,
    "sys_id",
    macroponentIds,
    ["sys_id", "name", "data"],
  );
  const scriptRows = await readIn(
    ctx,
    T.clientScript,
    "macroponent",
    macroponentIds,
    ["sys_id", "name", "macroponent"],
  );
  const brokersBy = new Map<string, { id: string; type?: string }[]>();
  const brokerIds = new Set<string>();
  for (const m of macroponentRows) {
    const brokers = macroponentUses(m).brokers.filter((b) => isSysId(b.id));
    brokersBy.set(str(m, "sys_id"), brokers);
    for (const b of brokers) brokerIds.add(b.id);
  }
  const brokerRows = new Map<string, { table: string; name?: string }>();
  for (const table of [
    "sys_ux_data_broker_transform",
    "sys_ux_data_broker_scriptlet",
  ]) {
    for (const r of await readIn(ctx, table, "sys_id", brokerIds, [
      "sys_id",
      "name",
    ])) {
      brokerRows.set(str(r, "sys_id"), { table, name: opt(r, "name") });
    }
  }
  const aclRows = await readIn(
    ctx,
    T.acl,
    "name",
    brokerIds,
    ["sys_id", "name", "operation"],
    "type=ux_data_broker",
  );

  // 3. Assemble pages.
  const byId = (rows: SnRecord[]) =>
    new Map(rows.map((r) => [str(r, "sys_id"), r]));
  const screens = byId(screenRows);
  const applicabilities = byId(applicabilityRows);
  const macroponents = byId(macroponentRows);
  const routesBy = groupBy(routeRows, "screen_type");
  const scriptsBy = groupBy(scriptRows, "macroponent");
  const aclsBy = groupBy(aclRows, "name");
  const named = (
    role: UibRole,
    table: string,
    row: SnRecord | undefined,
    sysId: string,
  ): UibExpected => ({
    role,
    table,
    sys_id: sysId,
    ...(row && opt(row, "name") ? { name: opt(row, "name") } : {}),
  });
  const macroponentNeeds = (mp: string): UibExpected[] => {
    if (!SYS_ID.test(mp)) return [];
    const out = [named("macroponent", T.macroponent, macroponents.get(mp), mp)];
    for (const s of scriptsBy.get(mp) ?? []) {
      out.push(named("client_script", T.clientScript, s, str(s, "sys_id")));
    }
    for (const b of brokersBy.get(mp) ?? []) {
      const known = brokerRows.get(b.id);
      out.push({
        role: "data_broker",
        table: known?.table ?? brokerTable(b.type).table,
        sys_id: b.id,
        ...(known?.name ? { name: known.name } : {}),
      });
      for (const a of aclsBy.get(b.id) ?? []) {
        out.push({
          role: "acl",
          table: T.acl,
          sys_id: str(a, "sys_id"),
          name: [str(a, "name"), opt(a, "operation")].filter(Boolean).join("."),
        });
      }
    }
    return out;
  };
  const needs: {
    page: Omit<UibPage, "expected" | "missing">;
    e: UibExpected[];
  }[] = [];
  for (const v of keptVariants) {
    const st = str(v, "screen_type");
    const mp = str(v, "macroponent");
    const e: UibExpected[] = [];
    for (const r of routesBy.get(st) ?? []) {
      e.push(named("route", T.route, r, str(r, "sys_id")));
    }
    if (SYS_ID.test(st)) e.push(named("screen", T.screen, screens.get(st), st));
    e.push(named("variant", T.variant, v, str(v, "sys_id")));
    const ap = str(v, "applicability");
    if (SYS_ID.test(ap)) {
      e.push(
        named("applicability", T.applicability, applicabilities.get(ap), ap),
      );
    }
    e.push(...macroponentNeeds(mp));
    needs.push({
      page: {
        variant: {
          sys_id: str(v, "sys_id"),
          ...(opt(v, "name") ? { name: opt(v, "name") } : {}),
        },
        ...(SYS_ID.test(mp)
          ? {
              macroponent: {
                sys_id: mp,
                ...(macroponents.get(mp) && opt(macroponents.get(mp)!, "name")
                  ? { name: opt(macroponents.get(mp)!, "name") }
                  : {}),
              },
            }
          : {}),
      },
      e,
    });
  }
  for (const mp of keptLone) {
    const row = macroponents.get(mp);
    needs.push({
      page: {
        macroponent: {
          sys_id: mp,
          ...(row && opt(row, "name") ? { name: opt(row, "name") } : {}),
        },
      },
      e: macroponentNeeds(mp),
    });
  }

  // 4. Membership: which expected records the set captures.
  const candidates = (x: UibExpected): string[] =>
    x.role === "data_broker"
      ? BROKER_TABLE_NAMES.map((t) => `${t}_${x.sys_id}`)
      : [`${x.table}_${x.sys_id}`];
  const wanted = new Set(needs.flatMap((n) => n.e.flatMap(candidates)));
  const captured = new Set<string>();
  let membershipKnown = true;
  const list = [...wanted];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    try {
      const { records } = await queryTable({
        table: "sys_update_xml",
        query: `update_set=${updateSet}^nameIN${list.slice(i, i + IN_CHUNK).join(",")}`,
        fields: ["name"],
        limit: ROW_LIMIT,
        displayValue: "false",
      });
      for (const r of records) captured.add(str(r, "name"));
    } catch (error) {
      if (isCancelled(error)) throw error;
      ctx.unavailable.push({
        table: "sys_update_xml",
        reason: error instanceof Error ? error.message : String(error),
      });
      membershipKnown = false;
      break;
    }
  }

  const pages: UibPage[] = needs.map(({ page, e }) => {
    const expected: Partial<Record<UibRole, number>> = {};
    const seen = new Set<string>();
    const missing: UibExpected[] = [];
    for (const x of e) {
      const key = `${x.role}:${x.sys_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expected[x.role] = (expected[x.role] ?? 0) + 1;
      if (membershipKnown && !candidates(x).some((c) => captured.has(c))) {
        missing.push(x);
      }
    }
    return { ...page, expected, missing };
  });

  const caveats = [
    "A record listed as missing may already exist on the target instance (out of the box, or shipped by an earlier update set); only records changed for this page need to travel with it.",
    "Only ux_data_broker ACLs of transform / scriptlet brokers and the variant's own applicability are checked; roles, page properties and nested macroponents are not.",
    "UI Builder table and field names and the <table>_<sys_id> update name are unverified (gate O-5).",
    ...ctx.caveats,
  ];
  if (opts.partial) {
    caveats.push(
      "Only the update rows returned by this call anchor pages (the read was truncated or filtered by type); raise limit or drop type to check every page.",
    );
  }
  const unresolved = [...brokerIds].filter((b) => !brokerRows.has(b));
  if (unresolved.length) {
    caveats.push(
      `${unresolved.length} data broker(s) are not transform or scriptlet brokers or could not be read; their table is inferred from the data resource type and their ACLs are not checked.`,
    );
  }
  if (!membershipKnown) {
    caveats.push(
      "sys_update_xml could not be read for membership: no record is reported missing.",
    );
  }
  return {
    checked: pages.length,
    complete:
      membershipKnown &&
      !ctx.unavailable.length &&
      pages.every((p) => !p.missing.length),
    pages,
    ...(truncated ? { truncated: true } : {}),
    ...(ctx.unavailable.length ? { unavailable: ctx.unavailable } : {}),
    caveats,
  };
}
