// N-62: compact-read goldens, before and after. The N-57 synthetic incident
// (100 columns) is read as `display_value=all` and run through each compact
// form of src/api/compact-read.ts; the golden pins the JSON bytes of every
// form, so a change to the encoding is a reviewed diff of
// test/fixtures/compact-read-sizes.json (refresh with UPDATE_GOLDEN=1).
// API level only: the tool options wait for O-21 (a), so tools/list is 0 B.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import {
  compactDisplayRecord,
  omitEmpty,
  toTableForm,
} from "../build/api/compact-read.js";
import { INCIDENT_COLUMNS, incident, sysId } from "./synthetic.js";

const GOLDEN = new URL("./fixtures/compact-read-sizes.json", import.meta.url);

// --- dictionary and display values -------------------------------------------

const CHOICES = {
  state: { 1: "New", 2: "In Progress", 3: "On Hold" },
  priority: { 1: "1 - Critical", 2: "2 - High", 3: "3 - Moderate" },
  impact: { 1: "1 - High", 2: "2 - Medium", 3: "3 - Low" },
  urgency: { 1: "1 - High", 2: "2 - Medium", 3: "3 - Low" },
};
const REFERENCES = {
  assignment_group: "sys_user_group",
  assigned_to: "sys_user",
  caller_id: "sys_user",
  opened_by: "sys_user",
};
const DATES = new Set(["opened_at", "sys_created_on", "sys_updated_on"]);

/** The `describeTable` columns of the synthetic incident. */
const COLUMNS = INCIDENT_COLUMNS.map((element) => {
  if (CHOICES[element]) return { element, type: "integer", choice: "3" };
  if (REFERENCES[element])
    return { element, type: "reference", reference: REFERENCES[element] };
  if (DATES.has(element)) return { element, type: "glide_date_time" };
  if (element === "sys_mod_count") return { element, type: "integer" };
  return { element, type: "string" };
});

/** A local-time display of a UTC stamp, as the instance would render it. */
const localDate = (utc) => {
  const [d, t] = utc.split(" ");
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y} ${t}`;
};

/** One incident as a `display_value=all` read returns it. */
function incidentAll(i) {
  const raw = incident(i);
  const out = {};
  for (const [field, value] of Object.entries(raw)) {
    if (CHOICES[field]) {
      out[field] = { display_value: CHOICES[field][value], value };
    } else if (REFERENCES[field]) {
      out[field] = {
        display_value: `Synthetic ${REFERENCES[field]} ${value.slice(-2)}`,
        link: `https://example.service-now.com/api/now/table/${REFERENCES[field]}/${value}`,
        value,
      };
    } else if (DATES.has(field)) {
      out[field] = { display_value: localDate(value), value };
    } else {
      out[field] = { display_value: value, value };
    }
  }
  return out;
}

/** The `fields:"summary"` set the heuristic resolves on this dictionary. */
const SUMMARY = [
  "sys_id",
  "number",
  "short_description",
  "state",
  "priority",
  "assigned_to",
  "assignment_group",
  "category",
  "sys_updated_on",
];
const pick = (record, fields) =>
  Object.fromEntries(fields.map((f) => [f, record[f]]));

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

// --- cases -------------------------------------------------------------------

const ROWS = { "1-row": 1, "200-rows": 200 };

/** Each form, from the `display_value=all` records it starts with. */
const FORMS = {
  "value-only": (all) =>
    all.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value])),
    ),
  "display-all": (all) => all,
  display: (all) => all.map((r) => compactDisplayRecord(r, COLUMNS)),
  "display+omit_empty": (all) =>
    omitEmpty(all.map((r) => compactDisplayRecord(r, COLUMNS))),
  table: (all) => toTableForm(all, { columns: INCIDENT_COLUMNS }),
  "summary.display-all": (all) => all.map((r) => pick(r, SUMMARY)),
  "summary.display": (all) =>
    all.map((r) => compactDisplayRecord(pick(r, SUMMARY), COLUMNS)),
  "summary.table": (all) => toTableForm(all, { columns: SUMMARY }),
};

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const measured = {};

for (const [rowsKey, n] of Object.entries(ROWS)) {
  const all = Array.from({ length: n }, (_, i) => incidentAll(i + 1));
  for (const [form, encode] of Object.entries(FORMS)) {
    const key = `incident.${rowsKey}.${form}`;
    test(`compact-read size: ${key}`, () => {
      measured[key] = bytes(encode(all));
      if (process.env.UPDATE_GOLDEN === "1") return;
      assert.equal(
        measured[key],
        golden.cases[key],
        `${key}: size changed; review it and refresh with UPDATE_GOLDEN=1`,
      );
    });
  }

  test(`compact forms beat display_value=all (${rowsKey})`, () => {
    const baseline = bytes(FORMS["display-all"](all));
    for (const form of ["display", "display+omit_empty", "table"]) {
      assert.ok(
        bytes(FORMS[form](all)) < baseline,
        `${form} is smaller than display-all`,
      );
    }
    const summary = bytes(FORMS["summary.display-all"](all));
    assert.ok(bytes(FORMS["summary.display"](all)) < summary);
    assert.ok(bytes(FORMS["summary.table"](all)) < summary);
  });
}

test("compact forms keep what the plan promises on the synthetic incident", () => {
  const r = compactDisplayRecord(incidentAll(1), COLUMNS);
  assert.deepEqual(r.assigned_to, [sysId("b2", 1), "Synthetic sys_user 01"]);
  assert.deepEqual(r.state, ["2", "In Progress"]);
  assert.equal(r.sys_updated_on, incident(1).sys_updated_on);
  assert.equal(r.number, incident(1).number);
});

test("compact-read goldens have no stale case", () => {
  if (process.env.UPDATE_GOLDEN === "1") return;
  const keys = Object.keys(ROWS).flatMap((r) =>
    Object.keys(FORMS).map((f) => `incident.${r}.${f}`),
  );
  assert.deepEqual(Object.keys(golden.cases).sort(), keys.sort());
});

test.after(() => {
  if (process.env.UPDATE_GOLDEN !== "1") return;
  const out = { synthetic: true, cases: measured };
  writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
});
