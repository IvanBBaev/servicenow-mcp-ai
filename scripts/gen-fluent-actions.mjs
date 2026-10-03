// P-29: the action.core input table of the Fluent flow emitter, generated from
// the pinned @servicenow/sdk devDependency (owner gate O-7).
//
// `wfa.action(action.core.X, …, inputs)` is type-checked with exact inputs
// (and `wfa.actionStep(actionStep.X, …)` with the mandatory ones):
// every visible mandatory input is required and an unknown or hidden one is an
// excess property. The emitter needs each core action's input names, column
// kinds and flags to emit a typed call (or fall back to the untyped sys_id
// form), so this script reads the SDK's built-in action definitions
// (sdk-core/src/external/flow/built-ins/actions/core/*.now.ts) and writes
// src/api/fluent-sdk-actions.ts. Nothing at runtime depends on the SDK.
//
//   node scripts/gen-fluent-actions.mjs            rewrite the table
//   node scripts/gen-fluent-actions.mjs --check    exit 1 when it is stale
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as prettier from "prettier";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK_CORE = path.join(ROOT, "node_modules", "@servicenow", "sdk-core");
const BUILT_INS = path.join(SDK_CORE, "src/external/flow/built-ins");
const DIR = path.join(BUILT_INS, "actions/core");
const STEPS = path.join(
  BUILT_INS,
  "action-steps/action-step-definitions.now.ts",
);
const TABLES = path.join(SDK_CORE, "src/fluent/tables");
const OUT = path.join(ROOT, "src", "api", "fluent-sdk-actions.ts");
const check = process.argv.includes("--check");

if (!existsSync(DIR)) {
  console.error(
    "gen-fluent-actions: @servicenow/sdk is not installed (npm install).",
  );
  process.exit(check ? 0 : 1);
}
const sdkVersion = JSON.parse(
  readFileSync(
    path.join(ROOT, "node_modules", "@servicenow", "sdk", "package.json"),
    "utf8",
  ),
).version;

/** Index just past the bracket matching `src[open]`, skipping strings. */
function matching(src, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      i = endOfString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

function endOfString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j;
  }
  return src.length;
}

/** Top-level `key: value` pairs of an object literal `{ … }` (value text). */
function props(objText) {
  const out = new Map();
  let i = 1;
  const re = /\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*/y;
  while (i < objText.length - 1) {
    re.lastIndex = i;
    const m = re.exec(objText);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] ?? m[2] ?? m[3];
    let j = re.lastIndex;
    const start = j;
    // The value runs to the next top-level comma or the closing brace.
    while (j < objText.length - 1 && objText[j] !== ",") {
      const c = objText[j];
      if ("({[".includes(c)) j = matching(objText, j);
      else if (c === "'" || c === '"' || c === "`")
        j = endOfString(objText, j) + 1;
      else j++;
    }
    out.set(key, objText.slice(start, j).trim());
    i = j + 1;
  }
  return out;
}

const unq = (s) => (s ?? "").replace(/^['"]|['"]$/g, "");

/** Every `export const X = <ctor>({ … })` of `src`, as { export name: spec }. */
function definitions(src, ctor, into) {
  const re = new RegExp(`export const (\\w+) = ${ctor}\\(`, "g");
  for (const head of src.matchAll(re)) {
    const cfgStart = src.indexOf("{", head.index);
    const cfg = props(src.slice(cfgStart, matching(src, cfgStart)));
    const inputs = {};
    const inputsText = cfg.get("inputs");
    if (inputsText) {
      for (const [name, value] of props(inputsText)) {
        const col = /^(\w+)Column\(/.exec(value);
        if (!col) continue;
        const argStart = value.indexOf("{");
        const arg =
          argStart < 0
            ? new Map()
            : props(value.slice(argStart, matching(value, argStart)));
        const attrs = arg.get("attributes")
          ? props(arg.get("attributes"))
          : new Map();
        const hidden = ["visible", "visible_in_fd"].some((a) =>
          ["false", "'false'"].includes(attrs.get(a) ?? ""),
        );
        inputs[name] = {
          kind: col[1],
          ...(arg.get("mandatory") === "true" ? { mandatory: true } : {}),
          ...(hidden ? { hidden: true } : {}),
        };
      }
    }
    into[head[1]] = {
      sysId: unq(cfg.get("$id")),
      name: unq(cfg.get("name")),
      inputs,
    };
  }
}

const actions = {};
for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith(".now.ts")) continue;
  definitions(readFileSync(path.join(DIR, file), "utf8"), "Action", actions);
}
const steps = {};
definitions(readFileSync(STEPS, "utf8"), "ActionStepDefinition", steps);
const sorted = (o) =>
  Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

// Record() data is typed by the SDK's table schemas: an integer / decimal /
// float column takes a number, so the emitter needs those columns (inherited
// ones included) of every table the SDK ships a schema for.
const NUMERIC = /^ {8}(\w+): (?:Integer|Decimal|Float)Column\(/gm;
const tables = {};
for (const file of readdirSync(TABLES).sort()) {
  if (!file.endsWith(".now.ts")) continue;
  const src = readFileSync(path.join(TABLES, file), "utf8");
  const name = /^ {4}name: '(\w+)'/m.exec(src)?.[1];
  if (!name) continue;
  tables[name] = {
    parent: /^ {4}extends: '(\w+)'/m.exec(src)?.[1],
    own: [...src.matchAll(NUMERIC)].map((m) => m[1]),
  };
}
const numericOf = (name, seen = new Set()) => {
  const t = tables[name];
  if (!t || seen.has(name)) return [];
  seen.add(name);
  return [...t.own, ...(t.parent ? numericOf(t.parent, seen) : [])];
};
const numeric = {};
for (const name of Object.keys(tables)) {
  const cols = [...new Set(numericOf(name))].sort();
  if (cols.length) numeric[name] = cols;
}

const json = JSON.stringify(sorted(actions), null, 2);
const stepsJson = JSON.stringify(sorted(steps), null, 2);
const raw = `// Generated by scripts/gen-fluent-actions.mjs from @servicenow/sdk ${sdkVersion}
// (sdk-core built-ins/actions/core, action-steps and fluent/tables). Do not edit; regenerate
// after an SDK bump.

/** One action.core input: its column kind (\`<kind>Column\`) and flags. */
export interface CoreActionInput {
  kind: string;
  /** Visible and mandatory: a typed call must pass it. */
  mandatory?: true;
  /** visible / visible_in_fd false: not part of the typed inputs. */
  hidden?: true;
}

/** One action.core action: its sys_id (the untyped \`wfa.action()\` form), name and inputs. */
export interface CoreActionSpec {
  sysId: string;
  name: string;
  inputs: Readonly<Record<string, CoreActionInput>>;
}

/** The SDK version the table was generated from. */
export const SDK_ACTIONS_VERSION = ${JSON.stringify(sdkVersion)};

/** \`action.core.*\` by export name. */
export const SDK_CORE_ACTIONS: Readonly<Record<string, CoreActionSpec>> = ${json};

/** \`actionStep.*\` (the steps of an Action() body) by export name. */
export const SDK_ACTION_STEPS: Readonly<Record<string, CoreActionSpec>> = ${stepsJson};

/** Integer / decimal / float columns (inherited included) of the tables the SDK has a schema for: \`Record()\` data takes a number there. */
export const SDK_NUMERIC_COLUMNS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(sorted(numeric), null, 2)};
`;

// Formatted like the rest of src/, so the format gate and --check agree.
const text = await prettier.format(raw, {
  ...(await prettier.resolveConfig(OUT)),
  filepath: OUT,
});
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
if (check) {
  if (current !== text) {
    console.error(
      "src/api/fluent-sdk-actions.ts is stale: run node scripts/gen-fluent-actions.mjs",
    );
    process.exit(1);
  }
  console.log("fluent-sdk-actions: up to date.");
} else {
  writeFileSync(OUT, text);
  console.log(
    `fluent-sdk-actions: ${Object.keys(actions).length} actions, ${Object.keys(steps).length} steps and ${Object.keys(numeric).length} table schemas from @servicenow/sdk ${sdkVersion}.`,
  );
}
