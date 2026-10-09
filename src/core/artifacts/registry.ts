/**
 * P-1 — the artefact registry (project/SDK-PARITY.md §5(a)).
 *
 * One data-driven list of every ServiceNow artefact type the server knows:
 * where it lives (primary table + ordered child tables), how it is named and
 * keyed, which fields hold script bodies, encoded JSON, dependency references
 * or credential material, and which ServiceNow SDK (Fluent) API describes it.
 * It holds data, not behaviour: readers, decoders and tree builders are keyed
 * by descriptor elsewhere.
 *
 * The model (shapes, SDK API lists, shared building blocks) is in
 * `registry-model.ts`; the rows are in four data files concatenated here in
 * registry order (`registry-scripts`, `-platform`, `-ui`, `-process`).
 *
 * Descriptors flagged `scriptTools: true` are served by the script-intelligence
 * tools (list / get / search_code / where_used / lint_script / snapshot /
 * compare / check_code_health); `SCRIPT_TYPES` in `src/api/scripts.ts` is a derived
 * view over exactly those, in registry order. The nine legacy script types
 * (`business_rule` … `acl`) come first and are `verified:true`; S-4 widened the
 * view to the other script-bearing tables (portal widgets, UI pages / scripts /
 * macros, processors, email / fix / validation scripts, transform maps and
 * entries, script actions, catalog client scripts, data sources, REST message
 * functions, dictionary calculations and defaults), all `verified:false`. The
 * remaining descriptors are seeds for the epic's generic tools (P-5 onwards).
 *
 * P-9 completed the Next Experience, UI Builder, Service Portal, Flow Designer
 * and legacy-workflow rows at the R tier. Their script-bearing tables (UIB
 * client scripts and data brokers, Angular providers and templates, portal
 * themes / CSS / search sources) are `scriptToolsOptIn`: reachable through the
 * script tools only on explicit request, so the default sweep is unchanged.
 *
 * P-8 added the Service Catalog definition records (items, record producers,
 * variable sets, variables, catalog client scripts and UI policies), the ATF /
 * scan-check / assessment rows, the AI Agent and Now Assist rows and the
 * application / dependency / customer-update / source-control rows. The AI
 * rows carry `licensed`: on an instance without the plugin they answer
 * `available:false` instead of an error.
 *
 * N-8 added reports and Performance Analytics (the `reporting` group): report
 * definitions and report sources, PA indicators, indicator sources, breakdowns,
 * PA scripts and PA dashboards, all read-only (R + X) seeds with reference
 * fields, so `list_artifacts`, `explain_artifact`, `artifact_dependencies`,
 * `document_app` and snapshot / compare cover them without new tools. The PA
 * rows carry `licensed` (gate O-9). PA scripts hold a script field but are not
 * script-tools types, so no tool enum grows.
 *
 * `verified:false` means gate O-5 has not confirmed the table and field names on
 * a live instance; names come from the 2026-09-23 SDK coverage inventory, and
 * anything the inventory marked (U) is unverified by definition.
 */

import {
  ARTIFACT_GROUPS,
  type ArtifactType,
  DECODER_IDS,
  type JsonField,
  type RefField,
  SDK_APIS,
  SDK_NEXT_APIS,
  type UniqueRule,
} from "./registry-model.js";
import { SCRIPT_ROWS } from "./registry-scripts.js";
import { PLATFORM_ROWS } from "./registry-platform.js";
import { UI_TYPES } from "./registry-ui.js";
import { PROCESS_ROWS } from "./registry-process.js";

export {
  SDK_BASELINE,
  SDK_APIS,
  SDK_NEXT_APIS,
  DECODER_IDS,
  ARTIFACT_GROUPS,
  PERFORMANCE_ANALYTICS,
} from "./registry-model.js";
export type {
  SdkApi,
  DecoderId,
  ArtifactGroup,
  Tier,
  JsonField,
  RefField,
  ArtifactChild,
  ArtifactType,
  UniqueRule,
} from "./registry-model.js";

export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  ...SCRIPT_ROWS,
  ...PLATFORM_ROWS,
  ...UI_TYPES,
  ...PROCESS_ROWS,
];

/** Registry lookup by type id. */
export function getArtifactType(type: string): ArtifactType | undefined {
  return ARTIFACT_TYPES.find((t) => t.type === type);
}

/**
 * Consistency problems in a descriptor list (empty when valid): duplicate
 * type ids, unknown groups / SDK APIs / decoders, a `next`-only SDK API on a
 * verified or G-tier type, a `sdkSince` on a type the
 * SDK does not model, script-tools / opt-in types without script fields or
 * with both flags, client / markup fields that are not script fields,
 * children without a parent field or with a parent table
 * that is neither the primary table nor an earlier child, an empty value link
 * (`parentKey` / `alsoMatch`) or an `alsoMatch` on a nested child, empty
 * or system-field P-24 unique / scope-prefix rules, and references to
 * unregistered types.
 */
export function validateArtifactTypes(
  types: readonly ArtifactType[] = ARTIFACT_TYPES,
): string[] {
  const problems: string[] = [];
  const ids = new Set(types.map((t) => t.type));
  const seen = new Set<string>();
  const checkJson = (where: string, fields: JsonField[] | undefined) => {
    for (const j of fields ?? []) {
      if (!(DECODER_IDS as readonly string[]).includes(j.decoder)) {
        problems.push(`${where}: unknown decoder '${j.decoder}' on ${j.field}`);
      }
    }
  };
  const checkRefs = (where: string, refs: RefField[] | undefined) => {
    for (const r of refs ?? []) {
      if (r.type !== undefined && !ids.has(r.type)) {
        problems.push(`${where}: ${r.field} references unknown type ${r.type}`);
      }
    }
  };
  const checkUnique = (where: string, rules: UniqueRule[] | undefined) => {
    for (const r of rules ?? []) {
      if (
        !r.fields.length ||
        r.fields.some((f) => !f || f.startsWith("sys_"))
      ) {
        problems.push(`${where}: a unique rule needs non-system fields`);
      }
    }
  };
  for (const t of types) {
    const where = t.type;
    if (seen.has(t.type)) problems.push(`${where}: duplicate type`);
    seen.add(t.type);
    if (!(ARTIFACT_GROUPS as readonly string[]).includes(t.group)) {
      problems.push(`${where}: unknown group '${t.group}'`);
    }
    if ((SDK_NEXT_APIS as readonly string[]).includes(t.sdkApi)) {
      if (t.verified || t.tiers.includes("G")) {
        problems.push(
          `${where}: next-only sdkApi '${t.sdkApi}' must be verified:false without a G tier`,
        );
      }
    } else if (
      t.sdkApi !== "none" &&
      !(SDK_APIS as readonly string[]).includes(t.sdkApi)
    ) {
      problems.push(`${where}: sdkApi '${t.sdkApi}' is not on the baseline`);
    }
    if (t.sdkApi === "none" && t.sdkSince !== null) {
      problems.push(`${where}: sdkSince set but sdkApi is 'none'`);
    }
    if (!t.table || !t.nameField || t.keyFields.length === 0) {
      problems.push(`${where}: table, nameField and keyFields are required`);
    }
    if (t.scriptTools && t.scriptFields.length === 0) {
      problems.push(`${where}: a script-tools type needs scriptFields`);
    }
    if (t.scriptToolsOptIn && t.scriptTools) {
      problems.push(`${where}: scriptTools and scriptToolsOptIn are exclusive`);
    }
    if (t.scriptToolsOptIn && t.scriptFields.length === 0) {
      problems.push(`${where}: an opt-in script type needs scriptFields`);
    }
    for (const f of [...(t.clientFields ?? []), ...(t.markupFields ?? [])]) {
      if (!t.scriptFields.includes(f)) {
        problems.push(`${where}: ${f} is not one of its scriptFields`);
      }
    }
    checkJson(where, t.jsonFields);
    checkRefs(where, t.refFields);
    for (const f of t.writeFields ?? []) {
      if (f.startsWith("sys_")) {
        problems.push(`${where}: writeFields may not name system field ${f}`);
      }
    }
    checkUnique(where, t.unique);
    for (const f of t.scopePrefixFields ?? []) {
      if (!f || f.startsWith("sys_")) {
        problems.push(`${where}: scopePrefixFields may not name ${f || "''"}`);
      }
    }
    const tables = new Set([t.table]);
    for (const c of t.children) {
      const cw = `${where} > ${c.table}`;
      if (!c.parentField) problems.push(`${cw}: missing parentField`);
      if (c.parentTable !== undefined && !tables.has(c.parentTable)) {
        problems.push(
          `${cw}: parentTable ${c.parentTable} is not declared before it`,
        );
      }
      if (
        c.parentKey === "" ||
        c.alsoMatch?.some((m) => !m.field || !m.parentKey)
      ) {
        problems.push(`${cw}: empty parentKey or alsoMatch field`);
      }
      if (c.alsoMatch?.length && (c.parentTable ?? t.table) !== t.table) {
        problems.push(`${cw}: alsoMatch needs the primary table as parent`);
      }
      for (const f of c.writeFields ?? []) {
        if (f.startsWith("sys_") || f === c.parentField) {
          problems.push(`${cw}: writeFields may not name ${f}`);
        }
      }
      checkUnique(cw, c.unique);
      tables.add(c.table);
      checkJson(cw, c.jsonFields);
      checkRefs(cw, c.refFields);
    }
  }
  return problems;
}
