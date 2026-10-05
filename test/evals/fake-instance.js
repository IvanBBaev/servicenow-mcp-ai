/**
 * N-49 — a fake ServiceNow backend for the skill evals.
 *
 * Two small in-memory instances ("dev" and "prod") behind the shared fetch
 * double (`createFetchDouble` in ../helpers.js). The record-mocks launcher
 * boots the real MCP server against them and saves each tool's answer as a
 * `claude plugin eval` mock, so an eval run never needs a ServiceNow instance.
 *
 * Safety: both hosts live under the reserved `.invalid` TLD (RFC 2606), so
 * they can never resolve, and `installFakeInstance` throws on any request to
 * another host before a response is built. Nothing here is imported by
 * `src/`, and `test/` is not part of the npm package.
 *
 * The Table API is answered generically from the dataset below, with a
 * deliberately small encoded-query evaluator (`=`, `!=`, `IN`, `LIKE`,
 * `STARTSWITH`, `ISEMPTY`, `ISNOTEMPTY`, `^OR`, `^NQ`, `ORDERBY…`). An
 * operator it does not know matches every row — the fake never pretends to
 * be precise, it only has to be plausible enough for a model to act on.
 */
import { createFetchDouble } from "../helpers.js";

export const DEV_HOST = "acme-dev.eval-double.invalid";
export const PROD_HOST = "acme-prod.eval-double.invalid";
export const FAKE_HOSTS = Object.freeze([DEV_HOST, PROD_HOST]);

/** A deterministic 32-hex sys_id from a short label. */
export function sid(label) {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 32; round++) {
    for (const ch of `${label}#${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 32);
}

const T0 = "2026-09-28 08:00:00";
const T1 = "2026-10-01 09:15:00";
const T2 = "2026-10-01 09:20:00";

export const INCIDENT_SYS_ID = sid("incident:INC0010001");
export const UPDATE_SET_SYS_ID = sid("update_set:Escalation rework");
export const BUSINESS_RULE_SYS_ID = sid("sys_script:Escalate P1 incidents");
export const SCRIPT_INCLUDE_SYS_ID = sid("sys_script_include:EscalationUtil");

const ESCALATION_RULE_DEV = [
  "(function executeRule(current, previous) {",
  "  if (current.priority == 1 && previous.priority != 1) {",
  "    new EscalationUtil().notifyOnCall(current);",
  "    gs.eventQueue('incident.escalated', current, current.assignment_group);",
  "  }",
  "})(current, previous);",
].join("\n");

const ESCALATION_RULE_PROD = [
  "(function executeRule(current, previous) {",
  "  if (current.priority == 1) {",
  "    gs.eventQueue('incident.escalated', current);",
  "  }",
  "})(current, previous);",
].join("\n");

const ESCALATION_UTIL = [
  "var EscalationUtil = Class.create();",
  "EscalationUtil.prototype = {",
  "  initialize: function() {},",
  "  notifyOnCall: function(inc) {",
  "    var gr = new GlideRecord('cmn_rota_member');",
  "    gr.addQuery('rota.group', inc.assignment_group);",
  "    gr.query();",
  "    while (gr.next()) {",
  "      gs.eventQueue('oncall.notify', inc, gr.member);",
  "    }",
  "  },",
  "  type: 'EscalationUtil'",
  "};",
].join("\n");

/** A single-record `sys_update_xml` payload, as the instance writes it. */
function updatePayload(table, fields) {
  const children = Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}">` +
    `<${table} action="INSERT_OR_UPDATE">${children}</${table}></record_update>`
  );
}

function dictionary(table, rows) {
  return rows.map(([element, label, type, extra = {}]) => ({
    sys_id: sid(`sys_dictionary:${table}.${element}`),
    name: table,
    element,
    column_label: label,
    internal_type: type,
    mandatory: "false",
    max_length: type === "string" ? "160" : "40",
    reference: "",
    active: "true",
    read_only: "false",
    default_value: "",
    ...extra,
  }));
}

/** The dev instance: the source of truth for every skill scenario. */
function devDataset() {
  return {
    sys_user: [
      {
        sys_id: sid("sys_user:eval.user"),
        user_name: "eval.user",
        name: "Eval User",
        email: "eval.user@example.invalid",
        active: "true",
      },
      {
        sys_id: sid("sys_user:beth.anglin"),
        user_name: "beth.anglin",
        name: "Beth Anglin",
        email: "beth.anglin@example.invalid",
        active: "true",
      },
    ],
    sys_properties: [
      {
        sys_id: sid("sys_properties:glide.buildtag"),
        name: "glide.buildtag.last",
        value: "glide-zurich-07-01-2025__patch2-09-10-2025",
      },
      {
        sys_id: sid("sys_properties:glide.war"),
        name: "glide.war",
        value: "glide-zurich-07-01-2025__patch2-09-10-2025.zip",
      },
    ],
    sys_db_object: [
      {
        sys_id: sid("sys_db_object:task"),
        name: "task",
        label: "Task",
        "super_class.name": "",
        super_class: "",
        sys_scope: "global",
        "sys_scope.scope": "global",
      },
      {
        sys_id: sid("sys_db_object:incident"),
        name: "incident",
        label: "Incident",
        "super_class.name": "task",
        super_class: sid("sys_db_object:task"),
        sys_scope: "global",
        "sys_scope.scope": "global",
      },
      {
        sys_id: sid("sys_db_object:u_vendor_contract"),
        name: "u_vendor_contract",
        label: "Vendor Contract",
        "super_class.name": "",
        super_class: "",
        sys_scope: sid("sys_app:x_acme_vendor"),
        "sys_scope.scope": "x_acme_vendor",
      },
    ],
    sys_dictionary: [
      ...dictionary("task", [
        ["number", "Number", "string"],
        ["short_description", "Short description", "string"],
        ["state", "State", "integer"],
        ["priority", "Priority", "integer"],
        [
          "assignment_group",
          "Assignment group",
          "reference",
          { reference: "sys_user_group" },
        ],
        ["assigned_to", "Assigned to", "reference", { reference: "sys_user" }],
      ]),
      ...dictionary("incident", [
        ["caller_id", "Caller", "reference", { reference: "sys_user" }],
        ["impact", "Impact", "integer"],
        ["urgency", "Urgency", "integer"],
        [
          "u_vendor_contract",
          "Vendor contract",
          "reference",
          {
            reference: "u_vendor_contract",
          },
        ],
      ]),
      ...dictionary("u_vendor_contract", [
        ["u_vendor", "Vendor", "string"],
        ["u_expires", "Expires", "glide_date"],
      ]),
    ],
    sys_choice: [
      ["1", "1 - Critical"],
      ["2", "2 - High"],
      ["3", "3 - Moderate"],
      ["4", "4 - Low"],
    ].map(([value, label]) => ({
      sys_id: sid(`sys_choice:incident.priority.${value}`),
      name: "incident",
      element: "priority",
      value,
      label,
      inactive: "false",
    })),
    incident: [
      {
        sys_id: INCIDENT_SYS_ID,
        number: "INC0010001",
        short_description: "Email delivery delayed for the finance team",
        state: "2",
        priority: "3",
        impact: "2",
        urgency: "2",
        caller_id: sid("sys_user:beth.anglin"),
        assigned_to: "",
        assignment_group: sid("sys_user_group:Service Desk"),
        sys_mod_count: "4",
        sys_created_on: T0,
        sys_updated_on: T1,
        sys_updated_by: "beth.anglin",
      },
      {
        sys_id: sid("incident:INC0010002"),
        number: "INC0010002",
        short_description: "VPN drops every 10 minutes",
        state: "1",
        priority: "1",
        impact: "1",
        urgency: "1",
        caller_id: sid("sys_user:eval.user"),
        assigned_to: "",
        assignment_group: sid("sys_user_group:Network"),
        sys_mod_count: "1",
        sys_created_on: T1,
        sys_updated_on: T2,
        sys_updated_by: "eval.user",
      },
    ],
    sys_script: [
      {
        sys_id: BUSINESS_RULE_SYS_ID,
        name: "Escalate P1 incidents",
        collection: "incident",
        when: "after",
        order: "100",
        active: "true",
        action_insert: "true",
        action_update: "true",
        action_delete: "false",
        action_query: "false",
        filter_condition: "priorityCHANGESTO1",
        condition: "",
        script: ESCALATION_RULE_DEV,
        sys_scope: "global",
        sys_updated_on: T1,
        sys_updated_by: "eval.user",
      },
    ],
    sys_script_include: [
      {
        sys_id: SCRIPT_INCLUDE_SYS_ID,
        name: "EscalationUtil",
        api_name: "global.EscalationUtil",
        active: "true",
        access: "package_private",
        client_callable: "false",
        script: ESCALATION_UTIL,
        sys_scope: "global",
        sys_updated_on: T1,
        sys_updated_by: "eval.user",
      },
    ],
    sys_update_set: [
      {
        sys_id: UPDATE_SET_SYS_ID,
        name: "Escalation rework",
        state: "in progress",
        application: "global",
        description: "Notify on-call when an incident becomes P1",
        sys_created_by: "eval.user",
        sys_created_on: T0,
        sys_updated_on: T2,
      },
    ],
    sys_update_xml: [
      {
        sys_id: sid("sys_update_xml:br"),
        update_set: UPDATE_SET_SYS_ID,
        name: `sys_script_${BUSINESS_RULE_SYS_ID}`,
        type: "Business Rule",
        target_name: "Escalate P1 incidents",
        action: "INSERT_OR_UPDATE",
        table: "sys_script",
        payload: updatePayload("sys_script", {
          sys_id: BUSINESS_RULE_SYS_ID,
          name: "Escalate P1 incidents",
          collection: "incident",
          when: "after",
          active: "true",
          script: ESCALATION_RULE_DEV,
        }),
        sys_updated_on: T1,
        sys_updated_by: "eval.user",
      },
      {
        sys_id: sid("sys_update_xml:si"),
        update_set: UPDATE_SET_SYS_ID,
        name: `sys_script_include_${SCRIPT_INCLUDE_SYS_ID}`,
        type: "Script Include",
        target_name: "EscalationUtil",
        action: "INSERT_OR_UPDATE",
        table: "sys_script_include",
        payload: updatePayload("sys_script_include", {
          sys_id: SCRIPT_INCLUDE_SYS_ID,
          name: "EscalationUtil",
          api_name: "global.EscalationUtil",
          active: "true",
          script: ESCALATION_UTIL,
        }),
        sys_updated_on: T1,
        sys_updated_by: "eval.user",
      },
    ],
    sys_report: [
      {
        sys_id: sid("sys_report:open-by-priority"),
        title: "Open incidents by priority",
        table: "incident",
        field: "priority",
        filter: "active=true^priorityIN1,2",
      },
    ],
    sys_ui_list_element: [
      {
        sys_id: sid("sys_ui_list_element:incident.priority"),
        element: "priority",
        "list_id.name": "incident",
        "list_id.view": "Default view",
        position: "3",
      },
    ],
    sys_app: [
      {
        sys_id: sid("sys_app:x_acme_vendor"),
        name: "Vendor Contracts",
        scope: "x_acme_vendor",
        version: "1.2.0",
        active: "true",
        sys_updated_on: T0,
      },
    ],
    sys_audit: [
      {
        sys_id: sid("sys_audit:1"),
        tablename: "incident",
        documentkey: INCIDENT_SYS_ID,
        fieldname: "priority",
        oldvalue: "4",
        newvalue: "3",
        user: "beth.anglin",
        sys_created_on: T1,
        record_checkpoint: "4",
      },
    ],
    syslog: [
      {
        sys_id: sid("syslog:1"),
        sys_created_on: T2,
        level: "2",
        source: "EscalationUtil",
        message:
          'TypeError: Cannot read property "member" of undefined (sys_script_include.EscalationUtil; line 8)',
      },
      {
        sys_id: sid("syslog:2"),
        sys_created_on: T2,
        level: "1",
        source: "Escalate P1 incidents",
        message: "Escalation skipped: no on-call rota for Network",
      },
    ],
  };
}

/** The prod instance: one table, one dictionary column and one rule behind. */
function prodDataset() {
  const dev = devDataset();
  return {
    ...dev,
    sys_db_object: dev.sys_db_object.filter(
      (r) => r.name !== "u_vendor_contract",
    ),
    sys_dictionary: dev.sys_dictionary.filter(
      (r) =>
        r.name !== "u_vendor_contract" && r.element !== "u_vendor_contract",
    ),
    sys_script: dev.sys_script.map((r) => ({
      ...r,
      script: ESCALATION_RULE_PROD,
      sys_updated_on: T0,
    })),
    sys_script_include: [],
    sys_update_set: [],
    sys_update_xml: [],
    sys_app: [],
    syslog: [],
  };
}

/** A fresh, mutable copy of both instances (writes land in it). */
export function createDatasets() {
  return { [DEV_HOST]: devDataset(), [PROD_HOST]: prodDataset() };
}

// --- encoded-query evaluator -------------------------------------------------

const OPERATORS = [
  "ISNOTEMPTY",
  "ISEMPTY",
  "STARTSWITH",
  "ENDSWITH",
  "NOT LIKE",
  "NOTLIKE",
  "LIKE",
  "NOT IN",
  "NOTIN",
  "IN",
  "!=",
  ">=",
  "<=",
  "=",
  ">",
  "<",
];

function parseTerm(term) {
  for (const op of OPERATORS) {
    const i = term.indexOf(op);
    if (i > 0 && /^[\w.]+$/.test(term.slice(0, i))) {
      return { field: term.slice(0, i), op, value: term.slice(i + op.length) };
    }
  }
  return null;
}

function matchTerm(row, term) {
  const parsed = parseTerm(term);
  if (!parsed) return true;
  const { field, op, value } = parsed;
  // A dot-walked field the dataset does not carry is not filtered on.
  if (!(field in row)) return field.includes(".") || op === "ISEMPTY";
  const actual = String(row[field] ?? "");
  switch (op) {
    case "=":
      return actual === value;
    case "!=":
      return actual !== value;
    case "IN":
      return value.split(",").includes(actual);
    case "NOT IN":
    case "NOTIN":
      return !value.split(",").includes(actual);
    case "LIKE":
      return actual.toLowerCase().includes(value.toLowerCase());
    case "NOT LIKE":
    case "NOTLIKE":
      return !actual.toLowerCase().includes(value.toLowerCase());
    case "STARTSWITH":
      return actual.startsWith(value);
    case "ENDSWITH":
      return actual.endsWith(value);
    case "ISEMPTY":
      return actual === "";
    case "ISNOTEMPTY":
      return actual !== "";
    default:
      // Date and numeric comparisons (often `javascript:` expressions) match.
      return true;
  }
}

/** Evaluate an encoded query; returns the matching rows, ordered. */
export function runQuery(rows, query = "") {
  const order = [];
  const alternatives = query.split("^NQ").map((part) => {
    const groups = [];
    for (const raw of part.split("^")) {
      if (!raw || raw === "EQ") continue;
      if (raw.startsWith("ORDERBYDESC")) {
        order.push({ field: raw.slice(11), desc: true });
      } else if (raw.startsWith("ORDERBY")) {
        order.push({ field: raw.slice(7), desc: false });
      } else if (raw.startsWith("OR") && groups.length > 0) {
        groups[groups.length - 1].push(raw.slice(2));
      } else {
        groups.push([raw]);
      }
    }
    return groups;
  });
  const out = rows.filter((row) =>
    alternatives.some((groups) =>
      groups.every((terms) => terms.some((t) => matchTerm(row, t))),
    ),
  );
  for (const { field, desc } of order.reverse()) {
    out.sort((a, b) => {
      const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return desc ? -cmp : cmp;
    });
  }
  return out;
}

function project(row, fields) {
  if (!fields) return { ...row };
  const out = {};
  for (const f of fields.split(",")) {
    if (f && f in row) out[f] = row[f];
  }
  return out;
}

function parseBody(body) {
  if (typeof body !== "string" || body === "") return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

// --- fetch-double routes -----------------------------------------------------

/**
 * Build a fetch double that answers for the two fake instances and install
 * it as `globalThis.fetch`. Returns `{ double, datasets, forbidden }`:
 * `forbidden` lists every request that targeted a non-fake host (it also
 * throws), so a caller can assert it stayed empty.
 */
export function installFakeInstance({ datasets = createDatasets() } = {}) {
  const forbidden = [];
  const json = (status, payload, headers = {}) => ({
    status,
    headers,
    json: payload,
  });
  const notFound = () =>
    json(404, {
      error: { message: "No Record found", detail: "Record doesn't exist" },
      status: "failure",
    });

  const dataFor = (call) => {
    const host = new URL(call.url).host;
    const data = datasets[host];
    if (!data) {
      forbidden.push(call.url);
      throw new Error(`fake instance: refused request to ${host}`);
    }
    return data;
  };

  const double = createFetchDouble();

  double.route("*", /^\/api\/now\/table\/[^/]+(\/[^/]+)?$/, (call) => {
    const data = dataFor(call);
    const [, , , , table, id] = call.path.split("/");
    const rows = (data[table] ??= []);
    const fields = call.query.get("sysparm_fields");
    if (call.method === "GET" && !id) {
      const matched = runQuery(rows, call.query.get("sysparm_query") ?? "");
      const offset = Number(call.query.get("sysparm_offset") ?? 0);
      const limit = Number(call.query.get("sysparm_limit") ?? 10_000);
      const page = matched.slice(offset, offset + limit);
      return json(
        200,
        { result: page.map((r) => project(r, fields)) },
        {
          "x-total-count": String(matched.length),
        },
      );
    }
    if (call.method === "POST" && !id) {
      const row = {
        sys_id: sid(`${table}:${rows.length + 1}:${call.body}`),
        sys_mod_count: "0",
        ...parseBody(call.body),
      };
      rows.push(row);
      return json(201, { result: project(row, fields) });
    }
    const row = rows.find((r) => r.sys_id === id);
    if (!row) return notFound();
    if (call.method === "GET")
      return json(200, { result: project(row, fields) });
    if (call.method === "PATCH" || call.method === "PUT") {
      Object.assign(row, parseBody(call.body));
      row.sys_mod_count = String(Number(row.sys_mod_count ?? 0) + 1);
      return json(200, { result: project(row, fields) });
    }
    if (call.method === "DELETE") {
      rows.splice(rows.indexOf(row), 1);
      return { status: 204, body: "" };
    }
    return json(405, { error: { message: "Method not allowed" } });
  });

  double.route("GET", /^\/api\/now\/stats\/[^/]+$/, (call) => {
    const data = dataFor(call);
    const table = call.path.split("/")[4];
    const matched = runQuery(
      data[table] ?? [],
      call.query.get("sysparm_query") ?? "",
    );
    const groupBy = call.query.get("sysparm_group_by");
    if (!groupBy) {
      return json(200, {
        result: { stats: { count: String(matched.length) } },
      });
    }
    const fieldsList = groupBy.split(",");
    const groups = new Map();
    for (const row of matched) {
      const key = fieldsList.map((f) => String(row[f] ?? "")).join("\u0000");
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return json(200, {
      result: [...groups].map(([key, count]) => ({
        stats: { count: String(count) },
        groupby_fields: key
          .split("\u0000")
          .map((value, i) => ({ field: fieldsList[i], value })),
      })),
    });
  });

  // Any other ServiceNow API (CI/CD, Flow Designer, scripted REST…) answers
  // as an instance without that plugin would: an empty, well-formed result.
  double.route("*", /^\/api\//, (call) => {
    dataFor(call);
    return json(200, { result: [] });
  });

  // Everything else (UI pages, processors) is unknown to the fake.
  double.route("*", /.*/, (call) => {
    dataFor(call);
    return json(404, { error: { message: `fake instance: ${call.path}` } });
  });

  double.install();
  return { double, datasets, forbidden };
}
