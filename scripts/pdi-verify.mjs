#!/usr/bin/env node
// O-5: check the tables and fields the code names against a live instance
// (meant for a PDI), read-only.
//
// Two sources of names:
//   - the artefact registry (build/core/artifacts), read semantically: every
//     table an artefact or child reads, every field it names (name, scope,
//     key, script, meta, json, ref, write, unique, parent link) and every
//     reference target table;
//   - reader calls in build/api and build/tools: an object literal with a
//     `table` and a `fields` array (queryTable and friends), literal or a
//     top-level const of the same file (spreads included), plus the field
//     names in the static parts of its encoded `query`.
//
// The instance side is sys_db_object (with the super_class chain, so an
// inherited field counts) and sys_dictionary. Only GETs go out, through the
// server's own client and the active profile's env file; nothing is printed
// from the credentials. Needs `npm run build` first.
//
// P-2: each artefact type also gets a verdict — confirmed when its table,
// every named field, its children and its reference targets all exist —
// and the report lists the unverified types the instance confirms.
//
//   node scripts/pdi-verify.mjs [--json] [--out FILE]
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "build");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

const NAME = /^[a-z0-9_]+$/;

/** table → field → Set<source> */
const refs = new Map();
/** table → Set<source> */
const tables = new Map();
/** artefact type → registry `verified` flag */
const typeVerified = new Map();

function addTable(table, src) {
  if (!table || !NAME.test(table)) return;
  const s = tables.get(table) ?? new Set();
  s.add(src);
  tables.set(table, s);
}

function addField(table, field, src) {
  if (!table || !field) return;
  const head = field.split(".")[0];
  if (!NAME.test(head)) return;
  addTable(table, src);
  const byField = refs.get(table) ?? new Map();
  refs.set(table, byField);
  const s = byField.get(head) ?? new Set();
  s.add(src);
  byField.set(head, s);
}

const SINGLE = [
  "nameField",
  "scopeField",
  "activeField",
  "appliesToField",
  "orderField",
  "parentField",
];
const LISTS = [
  "keyFields",
  "scriptFields",
  "clientFields",
  "markupFields",
  "secretFields",
  "metaFields",
  "whenFields",
  "writeFields",
  "scopePrefixFields",
];

function collectSpec(spec, table, src) {
  addTable(table, src);
  for (const k of SINGLE) addField(table, spec[k], src);
  for (const k of LISTS) for (const f of spec[k] ?? []) addField(table, f, src);
  for (const j of spec.jsonFields ?? []) addField(table, j.field, src);
  for (const r of spec.refFields ?? []) {
    addField(table, r.field, src);
    addTable(r.table, `${src} → ${r.field}`);
  }
  for (const u of spec.unique ?? []) {
    for (const f of u.fields) addField(u.table ?? table, f, src);
  }
}

async function collectRegistry() {
  const { ARTIFACT_TYPES } = await import(
    path.join(build, "core/artifacts/registry.js")
  );
  for (const a of ARTIFACT_TYPES) {
    const src = `artifact:${a.type}`;
    typeVerified.set(a.type, Boolean(a.verified));
    collectSpec(a, a.table, src);
    for (const c of a.children ?? []) {
      const parent = c.parentTable ?? a.table;
      collectSpec(c, c.table, `${src}>${c.table}`);
      if (c.parentKey) addField(parent, c.parentKey, `${src}>${c.table}`);
      for (const m of c.alsoMatch ?? []) {
        addField(c.table, m.field, `${src}>${c.table}`);
        addField(parent, m.parentKey, `${src}>${c.table}`);
      }
    }
  }
}

const literal = (n) =>
  n?.type === "Literal" && typeof n.value === "string"
    ? n.value
    : n?.type === "TemplateLiteral" && n.expressions.length === 0
      ? n.quasis[0].value.cooked
      : null;

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key in node) {
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit);
    else if (child && typeof child.type === "string") walk(child, visit);
  }
}

/**
 * The file's top-level `const` strings and string arrays, so a reader that
 * passes `table: TABLE` or `fields: [...BASE_FIELDS, "x"]` is still checked.
 * Names imported from another file stay unresolved.
 */
function fileConstants(ast) {
  const consts = new Map();
  for (const stmt of ast.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration" || decl.kind !== "const") continue;
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier" && d.init) consts.set(d.id.name, d.init);
    }
  }
  return consts;
}

function resolveString(n, consts) {
  if (n?.type === "Identifier" && consts.has(n.name)) {
    return literal(consts.get(n.name));
  }
  return literal(n);
}

function resolveList(n, consts, seen = new Set()) {
  if (n?.type === "Identifier" && consts.has(n.name) && !seen.has(n.name)) {
    seen.add(n.name);
    return resolveList(consts.get(n.name), consts, seen);
  }
  if (n?.type !== "ArrayExpression") return [];
  return n.elements.flatMap((el) =>
    el?.type === "SpreadElement"
      ? resolveList(el.argument, consts, seen)
      : [resolveString(el, consts)],
  );
}

/** Placeholder for a `${…}` part of a template literal query. */
const HOLE = "\u0001";

/**
 * Every `const` declared anywhere in the file, by name (a name may be bound
 * in several functions), so `{ table, query }` with a local `query` resolves.
 */
function allConstants(ast) {
  const all = new Map();
  walk(ast, (n) => {
    if (n.type !== "VariableDeclaration" || n.kind !== "const") return;
    for (const d of n.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      all.set(d.id.name, [...(all.get(d.id.name) ?? []), d.init]);
    }
  });
  return all;
}

/** The possible static texts of a query expression, `${…}` parts as HOLE. */
function queryTexts(n, consts, seen = new Set()) {
  if (n?.type === "Identifier") {
    if (seen.has(n.name) || !consts.has(n.name)) return [];
    const next = new Set(seen).add(n.name);
    return consts.get(n.name).flatMap((init) => queryTexts(init, consts, next));
  }
  if (n?.type === "TemplateLiteral") {
    return [n.quasis.map((q) => q.value.cooked).join(HOLE)];
  }
  if (n?.type === "ConditionalExpression") {
    return [
      ...queryTexts(n.consequent, consts, seen),
      ...queryTexts(n.alternate, consts, seen),
    ];
  }
  if (n?.type === "BinaryExpression" && n.operator === "+") {
    const left = queryTexts(n.left, consts, seen);
    const right = queryTexts(n.right, consts, seen);
    return (left.length ? left : [HOLE]).flatMap((l) =>
      (right.length ? right : [HOLE]).map((r) => l + r),
    );
  }
  const text = literal(n);
  return text === null ? [] : [text];
}

/**
 * Field names of an encoded query: the lower-case head of each term, before
 * its upper-case or symbolic operator. Terms that start with a `${…}` part
 * are skipped, as are `javascript:` values.
 */
function queryFields(text) {
  const out = [];
  for (let term of text.split(/\^NQ|\^OR|\^/)) {
    term = term.replace(/^(ORDERBYDESC|ORDERBY|GROUPBY)/, "");
    const m = /^[a-z][a-z0-9_.]*/.exec(term);
    if (!m || m[0] === "javascript") continue;
    out.push(m[0]);
  }
  return out;
}

function collectReaders() {
  for (const dir of ["api", "tools"]) {
    const base = path.join(build, dir);
    for (const rel of fs.readdirSync(base, { recursive: true })) {
      if (!rel.endsWith(".js")) continue;
      const file = path.join(base, rel);
      const ast = parse(fs.readFileSync(file, "utf8"), {
        ecmaVersion: "latest",
        sourceType: "module",
      });
      const consts = fileConstants(ast);
      const locals = allConstants(ast);
      const src = `reader:${dir}/${rel}`;
      walk(ast, (n) => {
        if (n.type !== "ObjectExpression") return;
        const props = new Map();
        for (const p of n.properties) {
          if (p.type === "Property" && !p.computed) {
            props.set(p.key.name ?? p.key.value, p.value);
          }
        }
        const table = resolveString(props.get("table"), consts);
        if (!table) return;
        for (const f of resolveList(props.get("fields"), consts)) {
          addField(table, f, src);
        }
        for (const text of queryTexts(props.get("query"), locals)) {
          for (const f of queryFields(text)) addField(table, f, src);
        }
      });
    }
  }
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

async function readAll(queryTable, table, query, fields) {
  const res = await queryTable({ table, query, fields, fetchAll: true });
  if (res.truncated) {
    throw new Error(`${table}: result truncated — raise SN_MAX_RECORDS`);
  }
  return res.records;
}

async function main() {
  await collectRegistry();
  collectReaders();

  const { loadEnv } = await import(path.join(build, "core/config.js"));
  loadEnv();
  const { queryTable } = await import(path.join(build, "api/table.js"));

  // sys_db_object, then each missing ancestor until the chains close.
  const parent = new Map();
  let wanted = [...tables.keys()];
  while (wanted.length) {
    for (const part of chunk(wanted, 80)) {
      const rows = await readAll(
        queryTable,
        "sys_db_object",
        `nameIN${part.join(",")}`,
        ["name", "super_class.name"],
      );
      for (const r of rows) parent.set(r.name, r["super_class.name"] || "");
    }
    wanted = [...new Set(parent.values())].filter((p) => p && !parent.has(p));
  }

  const chain = (t) => {
    const out = [];
    for (let c = t; c && !out.includes(c); c = parent.get(c)) out.push(c);
    return out;
  };

  // sys_dictionary rows for every needed field on the table or an ancestor.
  const needed = new Set();
  for (const byField of refs.values())
    for (const f of byField.keys()) needed.add(f);
  const present = new Set();
  const dictTables = [...new Set([...refs.keys()].flatMap(chain))].filter((t) =>
    parent.has(t),
  );
  const fieldList = [...needed].sort().join(",");
  for (const part of chunk(dictTables, 40)) {
    const rows = await readAll(
      queryTable,
      "sys_dictionary",
      `nameIN${part.join(",")}^elementIN${fieldList}`,
      ["name", "element"],
    );
    for (const r of rows) present.add(`${r.name}.${r.element}`);
  }

  const missingTables = [];
  const missingFields = [];
  for (const [table, srcs] of [...tables].sort()) {
    if (!parent.has(table)) {
      missingTables.push({ table, sources: [...srcs].sort() });
    }
  }
  for (const [table, byField] of [...refs].sort()) {
    if (!parent.has(table)) continue;
    const up = chain(table);
    for (const [field, srcs] of [...byField].sort()) {
      if (!up.some((t) => present.has(`${t}.${field}`))) {
        missingFields.push({ table, field, sources: [...srcs].sort() });
      }
    }
  }

  const fieldCount = [...refs.values()].reduce((n, m) => n + m.size, 0);
  const result = {
    tables: tables.size,
    fields: fieldCount,
    missingTables,
    missingFields,
    types: typeVerdicts(missingTables, missingFields),
  };

  const text = asJson ? JSON.stringify(result, null, 2) : report(result);
  if (outFile) fs.writeFileSync(outFile, text + "\n");
  else process.stdout.write(text + "\n");
}

/** Does a source string belong to the artefact type (itself or a child)? */
const ofType = (src, type) => {
  const own = `artifact:${type}`;
  return (
    src === own || src.startsWith(`${own}>`) || src.startsWith(`${own} → `)
  );
};

/**
 * P-2: per artefact type, the names the instance lacks; `confirmed` when
 * none is missing. `verified` is the registry flag as it stands.
 */
function typeVerdicts(missingTables, missingFields) {
  return [...typeVerified].sort().map(([type, verified]) => {
    const missing = [
      ...missingTables
        .filter((m) => m.sources.some((s) => ofType(s, type)))
        .map((m) => m.table),
      ...missingFields
        .filter((m) => m.sources.some((s) => ofType(s, type)))
        .map((m) => `${m.table}.${m.field}`),
    ];
    return { type, verified, confirmed: missing.length === 0, missing };
  });
}

function report({ tables: t, fields: f, missingTables, missingFields, types }) {
  const confirmable = types.filter((v) => !v.verified && v.confirmed);
  const contradicted = types.filter((v) => v.verified && !v.confirmed);
  const lines = [
    `Checked ${t} tables and ${f} table.field names.`,
    "",
    `Missing tables (${missingTables.length}):`,
    ...missingTables.map((m) => `  ${m.table}  ← ${m.sources.join(", ")}`),
    "",
    `Missing fields (${missingFields.length}):`,
    ...missingFields.map(
      (m) => `  ${m.table}.${m.field}  ← ${m.sources.join(", ")}`,
    ),
    "",
    `Unverified types the instance confirms (${confirmable.length}):`,
    ...confirmable.map((v) => `  ${v.type}`),
    "",
    `Verified types with missing names (${contradicted.length}):`,
    ...contradicted.map((v) => `  ${v.type}  ← ${v.missing.join(", ")}`),
  ];
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
