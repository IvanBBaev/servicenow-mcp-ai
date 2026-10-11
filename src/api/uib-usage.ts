import { decodeField } from "../core/artifacts/decoders.js";
import {
  compositionTree,
  dataResources,
  type UibElement,
} from "../core/artifacts/uib-composition.js";
import { snString } from "./shared.js";
import { isSysId } from "../core/sys-id.js";

/**
 * N-28 (UX-07, UX-08) — what a UI Builder macroponent and its client scripts
 * use, read from configuration rather than from script text:
 *
 * - composition component ids: each element's `definition.id` names the
 *   macroponent (page, component or viewport) it renders;
 * - data resource broker ids: each `data` element's `definition.id` names a
 *   data broker record (transform, scriptlet, REST, GraphQL…);
 * - client script includes: a UIB client script reaches an include through
 *   the handler's `imports` argument, `imports['scope.Name']`.
 *
 * Pure: no I/O. The dependency graph (`get_artifact_dependencies`) turns these
 * into edges, the S-9 structural pass (`where_used`) into structural refs.
 *
 * O-5 (a PDI) confirmed the data resource side: `definition.id` is the
 * sys_id of a record in the table its `definition.type` names (seven types on
 * the PDI, CONTROLLER being a sys_ux_controller rather than a broker), and an
 * import key is the include's `api_name`, `scope.name`, whose name may hold
 * spaces. Still unverified: that `definition.id` is the sys_ux_macroponent
 * sys_id for composition elements.
 */

/**
 * Data resource tables by `definition.type` (O-5). Composite, client state
 * and controller resources have no registry type.
 */
export const BROKER_TABLES: Readonly<
  Record<string, { table: string; type?: string }>
> = {
  TRANSFORM: {
    table: "sys_ux_data_broker_transform",
    type: "uib_data_broker_transform",
  },
  SCRIPTLET: {
    table: "sys_ux_data_broker_scriptlet",
    type: "uib_data_broker_scriptlet",
  },
  REST: { table: "sys_ux_data_broker_rest", type: "uib_data_broker_rest" },
  GRAPHQL: {
    table: "sys_ux_data_broker_graphql",
    type: "uib_data_broker_graphql",
  },
  COMPOSITE: { table: "sys_ux_data_broker_composite" },
  CLIENT_STATE: { table: "sys_ux_data_broker_proxy" },
  CONTROLLER: { table: "sys_ux_controller" },
};

/**
 * The parent table of every data broker table: a broker whose data resource
 * has no recognised `definition.type` is placed here.
 */
export const BROKER_BASE_TABLE = "sys_ux_data_broker";

/** Every table a data resource can point at. */
export const BROKER_TABLE_NAMES: readonly string[] = [
  ...new Set([
    ...Object.values(BROKER_TABLES).map((b) => b.table),
    BROKER_BASE_TABLE,
  ]),
];

/** The broker table (and registry type) for a data resource type. */
export function brokerTable(type: string | undefined): {
  table: string;
  type?: string;
} {
  return (
    BROKER_TABLES[(type ?? "").toUpperCase()] ?? {
      table: BROKER_BASE_TABLE,
    }
  );
}

/** One component a composition renders. */
export interface UibComponentUse {
  /** `definition.id` — a sys_ux_macroponent sys_id (O-5). */
  id: string;
  /** `definition.type` (e.g. MACROPONENT, COMPONENT). */
  type?: string;
  /** Elements rendering it. */
  elements: string[];
}

/** One data broker a macroponent's data resources call. */
export interface UibBrokerUse {
  id: string;
  type?: string;
  elements: string[];
}

/** Component ids of a decoded composition (pure, de-duplicated). */
export function compositionComponents(value: unknown): UibComponentUse[] {
  const out = new Map<string, UibComponentUse>();
  const visit = (elements: UibElement[]) => {
    for (const el of elements) {
      if (el.component) {
        const known = out.get(el.component);
        if (known) known.elements.push(el.elementId);
        else {
          out.set(el.component, {
            id: el.component,
            ...(el.type ? { type: el.type } : {}),
            elements: [el.elementId],
          });
        }
      }
      for (const slot of el.slots) visit(slot.elements);
    }
  };
  visit(compositionTree(value).elements);
  return [...out.values()];
}

/** Broker ids of a decoded `data` value (pure, de-duplicated). */
export function dataBrokers(value: unknown): UibBrokerUse[] {
  const out = new Map<string, UibBrokerUse>();
  for (const d of dataResources(value) ?? []) {
    if (!d.broker) continue;
    const known = out.get(d.broker);
    if (known) known.elements.push(d.elementId);
    else {
      out.set(d.broker, {
        id: d.broker,
        ...(d.type ? { type: d.type } : {}),
        elements: [d.elementId],
      });
    }
  }
  return [...out.values()];
}

/** Decode one raw macroponent column; `undefined` when it does not decode. */
function decoded(decoder: "uib-composition" | "json", raw: string): unknown {
  if (!raw) return undefined;
  const d = decodeField(decoder, raw);
  return d.decoded ? d.value : undefined;
}

/** What one sys_ux_macroponent row uses (pure). */
export interface MacroponentUses {
  components: UibComponentUse[];
  brokers: UibBrokerUse[];
}

/** Components and brokers of a raw sys_ux_macroponent row (pure). */
export function macroponentUses(row: Record<string, unknown>): MacroponentUses {
  const composition = decoded("uib-composition", snString(row.composition));
  const data = decoded("json", snString(row.data));
  return {
    components:
      composition === undefined ? [] : compositionComponents(composition),
    brokers: data === undefined ? [] : dataBrokers(data),
  };
}

/**
 * The client script include sys_ids in a UIB client script's `includes`
 * list (pure): a comma-separated glide_list, de-duplicated; values that are
 * not sys_ids are dropped. O-5: a glide_list of sys_ux_client_script_include.
 */
export function uibIncludeIds(value: string): string[] {
  const ids = new Set<string>();
  for (const part of value.split(",")) {
    const v = part.trim();
    if (isSysId(v)) ids.add(v);
  }
  return [...ids];
}

/**
 * Client script include names a UIB client script imports (pure):
 * `imports['global.MyInclude']`, `imports["MyInclude"]` and
 * `imports.MyInclude`. The key is the include's `api_name`; the scope prefix
 * is dropped, as the include record's `name` holds the rest (O-5), spaces
 * and dots included (`imports['x_acme.Load Pendo']` → `Load Pendo`).
 */
export function uibImports(text: string): string[] {
  if (!text || !text.includes("imports")) return [];
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\bimports\s*\[\s*(["'`])([^"'`\]\r\n]+)\1\s*\]/g,
  )) {
    names.add(m[2]!.trim().replace(/^[A-Za-z0-9_]+\./, ""));
  }
  for (const m of text.matchAll(/\bimports\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!);
  }
  names.delete("");
  return [...names];
}
