import { type SnRecord } from "./table.js";
import {
  brokerMutates,
  lintUibBroker,
  type UibBrokerKind,
} from "./uib-broker-lint.js";
import {
  Collector,
  type Ctx,
  type DomainRuleId,
  need,
  NEWEST,
  NOT_OOB,
  raw,
  read,
  readIn,
  refOf,
  str,
} from "./domain-rules-shared.js";

/**
 * P-19 UI Builder rules (`uib-*`).
 */

const BROKER_TABLES = [
  ["sys_ux_data_broker_transform", "uib_data_broker_transform"],
  ["sys_ux_data_broker_scriptlet", "uib_data_broker_scriptlet"],
] as const;

/** Broker reads: table, registry type, kind, fields (N-29; O-5 unverified). */
const BROKER_READS: readonly (readonly [
  string,
  string,
  UibBrokerKind,
  string[],
])[] = [
  [
    "sys_ux_data_broker_transform",
    "uib_data_broker_transform",
    "transform",
    ["sys_id", "name", "mutates_server_data", "properties", "script"],
  ],
  [
    "sys_ux_data_broker_scriptlet",
    "uib_data_broker_scriptlet",
    "scriptlet",
    ["sys_id", "name", "properties"],
  ],
  [
    "sys_ux_data_broker_rest",
    "uib_data_broker_rest",
    "rest",
    ["sys_id", "name", "mutates_server_data", "properties"],
  ],
  [
    "sys_ux_data_broker_graphql",
    "uib_data_broker_graphql",
    "graphql",
    ["sys_id", "name", "mutates_server_data", "properties"],
  ],
];

export async function analyseUib(ctx: Ctx, out: Collector): Promise<void> {
  const { limit } = ctx;

  // 1. Routes whose screen type has no screen.
  await out.run(["uib-route-no-screen"], async () => {
    const routes = need(
      ctx,
      await read(
        ctx,
        "sys_ux_app_route",
        `${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "route_type", "screen_type", "app_config"],
        limit,
      ),
      "sys_ux_app_route",
    );
    out.scanned("uib-route-no-screen", routes.rows.length, routes.capped);
    const types = routes.rows.map((r) => str(r, "screen_type")).filter(Boolean);
    const screens = types.length
      ? need(
          ctx,
          await readIn(ctx, "sys_ux_screen", "screen_type", types, [
            "screen_type",
          ]),
          "sys_ux_screen",
        )
      : { rows: [], capped: false };
    // A capped screen read leaves every type unknown: report nothing.
    if (screens.capped) {
      out.scanned("uib-route-no-screen", 0, true);
      return;
    }
    const withScreen = new Set(screens.rows.map((r) => str(r, "screen_type")));
    for (const r of routes.rows) {
      const type = str(r, "screen_type");
      if (type && withScreen.has(type)) continue;
      out.add(
        "uib-route-no-screen",
        refOf("uib_route", "sys_ux_app_route", r),
        type
          ? "The route's screen type has no screen (variant): navigating to it renders nothing. Add a screen or remove the route."
          : "The route has no screen type: navigating to it renders nothing.",
        {
          ...(type ? { screenType: type } : {}),
          ...(str(r, "app_config") ? { appConfig: str(r, "app_config") } : {}),
        },
      );
    }
  });

  // 2. Screens with no applicability (audience).
  await out.run(["uib-screen-no-applicability"], async () => {
    const screens = need(
      ctx,
      await read(
        ctx,
        "sys_ux_screen",
        `applicabilityISEMPTY^${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "screen_type", "order"],
        limit,
      ),
      "sys_ux_screen",
    );
    out.scanned(
      "uib-screen-no-applicability",
      screens.rows.length,
      screens.capped,
    );
    const types = screens.rows
      .map((r) => str(r, "screen_type"))
      .filter(Boolean);
    const siblings = types.length
      ? await readIn(ctx, "sys_ux_screen", "screen_type", types, [
          "sys_id",
          "screen_type",
          "order",
        ])
      : { rows: [], capped: false };
    if (!siblings || siblings.capped) {
      out.scanned("uib-screen-no-applicability", 0, true);
    }
    const byType = new Map<string, SnRecord[]>();
    for (const r of siblings?.rows ?? []) {
      const list = byType.get(str(r, "screen_type")) ?? [];
      list.push(r);
      byType.set(str(r, "screen_type"), list);
    }
    const order = (r: SnRecord): number => {
      const n = Number(str(r, "order"));
      return Number.isFinite(n) ? n : 0;
    };
    for (const r of screens.rows) {
      const shadowed = (byType.get(str(r, "screen_type")) ?? []).filter(
        (x) => str(x, "sys_id") !== str(r, "sys_id") && order(x) > order(r),
      ).length;
      out.add(
        "uib-screen-no-applicability",
        refOf("uib_screen", "sys_ux_screen", r),
        shadowed
          ? `The screen has no applicability, so it matches every user and shadows ${shadowed} later variant(s) of its screen type. Give it an audience or move it last.`
          : "The screen has no applicability: every user sees it. Confirm it is the intended default variant.",
        { order: order(r), shadowedVariants: shadowed },
        shadowed ? "warn" : "info",
      );
    }
  });

  // 3. Data brokers, read once: transform / scriptlet (the tables the
  // rules need) plus the N-29 REST / GraphQL brokers (optional — an
  // unreadable one is skipped; O-5: unverified tables).
  const brokers: {
    row: SnRecord;
    table: string;
    type: string;
    kind: UibBrokerKind;
  }[] = [];
  let brokersCapped = false;
  let anyBrokerTable = false;
  for (const [table, type, kind, fields] of BROKER_READS) {
    const r = await read(ctx, table, `${NOT_OOB}^${NEWEST}`, fields, limit);
    if (!r) continue;
    if (kind === "transform" || kind === "scriptlet") anyBrokerTable = true;
    brokersCapped ||= r.capped;
    for (const row of r.rows) brokers.push({ row, table, type, kind });
  }
  const coreTables = BROKER_TABLES.map(([t]) => t);
  const isCore = (b: { kind: UibBrokerKind }): boolean =>
    b.kind === "transform" || b.kind === "scriptlet";

  // 3a. Brokers with no ux_data_broker ACL: `uib-data-broker-no-acl` for a
  // transform / scriptlet, `uib-broker-mutates-no-acl` (error, N-29) instead
  // for any broker that declares mutates_server_data.
  const aclRules: DomainRuleId[] = [
    "uib-data-broker-no-acl",
    "uib-broker-mutates-no-acl",
  ];
  await out.run(aclRules, async () => {
    if (!anyBrokerTable) need(ctx, null, ...coreTables);
    out.scanned(
      "uib-data-broker-no-acl",
      brokers.filter(isCore).length,
      brokersCapped,
    );
    out.scanned("uib-broker-mutates-no-acl", brokers.length, brokersCapped);
    if (!brokers.length) return;
    const acls = need(
      ctx,
      await readIn(
        ctx,
        "sys_security_acl",
        "name",
        brokers.map((b) => str(b.row, "sys_id")),
        ["name"],
        "^type=ux_data_broker",
      ),
      "sys_security_acl",
    );
    // A capped ACL read cannot prove a broker has none: report nothing.
    if (acls.capped) {
      for (const rule of aclRules) out.scanned(rule, 0, true);
      return;
    }
    const guarded = new Set(acls.rows.map((r) => str(r, "name")));
    for (const b of brokers) {
      if (guarded.has(str(b.row, "sys_id"))) continue;
      if (brokerMutates(raw(b.row, "mutates_server_data"))) {
        out.add(
          "uib-broker-mutates-no-acl",
          refOf(b.type, b.table, b.row),
          "The data broker declares mutates_server_data and no ux_data_broker ACL names it: a page can change server data through it without an access check. Add an ACL of type ux_data_broker with the broker's sys_id as its name.",
          { kind: b.kind },
        );
        continue;
      }
      if (!isCore(b)) continue;
      out.add(
        "uib-data-broker-no-acl",
        refOf(b.type, b.table, b.row),
        "No ux_data_broker ACL names this data broker: depending on the release it either cannot execute for non-admin users or runs unguarded. Add an ACL of type ux_data_broker with the broker's sys_id as its name.",
      );
    }
  });

  // 3b. N-29: transform scripts that query without an access check, and
  // brokers with no input schema (pure, from the broker rows).
  const lintRules: DomainRuleId[] = [
    "uib-transform-gliderecord-no-acl-check",
    "uib-broker-no-input-schema",
  ];
  await out.run(lintRules, () => {
    if (!anyBrokerTable) need(ctx, null, ...coreTables);
    out.scanned(
      "uib-transform-gliderecord-no-acl-check",
      brokers.filter((b) => b.kind === "transform").length,
      brokersCapped,
    );
    out.scanned("uib-broker-no-input-schema", brokers.length, brokersCapped);
    for (const b of brokers) {
      const findings = lintUibBroker({
        kind: b.kind,
        properties: raw(b.row, "properties"),
        script: raw(b.row, "script"),
      });
      for (const f of findings) {
        out.add(f.rule, refOf(b.type, b.table, b.row), f.message, {
          kind: b.kind,
          ...(f.line ? { line: f.line } : {}),
        });
      }
    }
    return Promise.resolve();
  });
}
