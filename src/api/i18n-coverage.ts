import { decodeField } from "../core/artifacts/decoders.js";
import { requiredTranslations } from "../core/artifacts/uib-translations.js";
import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import { scopeClause } from "./scripts.js";
import { mdEscape, mdTable, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";
import { isSysIdAnyCase } from "../core/sys-id.js";

/**
 * N-7 (NX-07) — translation coverage of one application scope and / or a set
 * of UI Builder macroponents, per language:
 *
 * - `messages`: the scope's `sys_ui_message` keys;
 * - `labels`: field and table labels (`sys_documentation`) of the scope's tables;
 * - `choices`: choice values (`sys_choice`) of the scope's tables;
 * - `translatedText`: `sys_translated_text` values of the scope's tables;
 * - `translatedFields`: `sys_translated` values (translated_field columns) of
 *   the scope's tables, keyed by table, field and source value;
 * - `uibStrings`: the user-facing strings of each macroponent's composition
 *   plus its declared `required_translations` (N-31 `requiredTranslations`),
 *   matched against `sys_ui_message` keys in any scope.
 *
 * The keys of a source category are every key seen in any language, so a
 * label translated into French but not German is missing for `de`. Each
 * source degrades on its own: an unreadable table becomes a caveat and the
 * category is reported `unreadable`, never a thrown error (except a cancel).
 *
 * Reached through the `document_app` kind `i18n` (doc-i18n.ts). Every table
 * and field name here is unverified until O-5 (PDI).
 */

export const I18N_LIMITS = {
  /** Missing keys kept per language and category by default. */
  sample: 20,
  /** Upper bound of a caller's `sampleSize`. */
  sampleMax: 100,
  /** Tables per `nameIN` / `tablenameIN` read. */
  tablesPerRead: 50,
  /** Characters of OR-ed `key=` clauses per sys_ui_message read. */
  keyQueryChars: 3000,
  /** Macroponents named by sys_id. */
  macroponents: 200,
} as const;

export const I18N_CATEGORIES = [
  "messages",
  "labels",
  "choices",
  "translatedText",
  "translatedFields",
  "uibStrings",
] as const;
export type I18nCategory = (typeof I18N_CATEGORIES)[number];

/** How a source category was read. */
export interface I18nSource {
  category: I18nCategory;
  table: string;
  /** `skipped`: not applicable to the input (e.g. no scope given). */
  status: "read" | "unreadable" | "skipped";
  /** Distinct keys the coverage is measured against. */
  keys: number;
  /** Translation rows read. */
  rows: number;
  /** The read stopped at SN_MAX_RECORDS. */
  truncated?: true;
}

export interface I18nCategoryCoverage {
  category: I18nCategory;
  total: number;
  translated: number;
  missing: number;
  /** The first missing keys, sorted, at most the sample size. */
  sample: string[];
}

export interface I18nLanguageCoverage {
  language: string;
  name?: string;
  /** Sums over the readable categories. */
  total: number;
  translated: number;
  missing: number;
  categories: I18nCategoryCoverage[];
}

export interface I18nCoverageReport {
  scope?: string;
  /** Macroponents whose strings were checked. */
  macroponents: number;
  baseLanguage: string;
  /** Where the language list came from. */
  languageSource: "given" | "sys_language" | "observed";
  sources: I18nSource[];
  languages: I18nLanguageCoverage[];
  caveats: string[];
}

export interface I18nCoverageOptions {
  /** Application scope: namespace (`x_acme_app`) or sys_app sys_id. */
  scope?: string;
  /** sys_ux_macroponent sys_ids; default: the scope's macroponents. */
  macroponents?: string[];
  /** Language codes; default: active `sys_language` rows. */
  languages?: string[];
  /** The source language, left out of the default list (default `en`). */
  baseLanguage?: string;
  /** Missing keys kept per language and category. */
  sampleSize?: number;
}

/** One translation row reduced to its key and language. */
export interface I18nRow {
  key: string;
  language: string;
}

export const I18N_CAVEAT =
  "Translation coverage (N-7) is unverified (gate O-5): sys_ui_message (key, language), sys_documentation (name, element, language), sys_choice (name, element, value, language), sys_translated_text (tablename, fieldname, documentkey, language), sys_translated (name, element, value, language), sys_language (id, name, active) and the UIB message-key convention (the English string is the sys_ui_message key) are assumptions. The keys of a category are those seen in any language, so a value never translated into any language is not counted.";

const LANGUAGE = /^[a-z]{2,3}([_-][a-z0-9]{2,8})*$/i;
const SAFE_TABLE = /^[a-z0-9_]{1,80}$/;

const str = (row: SnRecord, field: string): string => snString(row[field]);
const lang = (s: string): string => s.trim().toLowerCase();

/**
 * Coverage of `keys` in `language` from translation `rows` (pure): a key is
 * translated when some row carries it in that language (case-insensitive).
 */
export function categoryCoverage(
  category: I18nCategory,
  keys: Iterable<string>,
  rows: Iterable<I18nRow>,
  language: string,
  sampleSize: number = I18N_LIMITS.sample,
): I18nCategoryCoverage {
  const want = lang(language);
  const have = new Set<string>();
  for (const r of rows) if (lang(r.language) === want) have.add(r.key);
  const all = [...new Set(keys)].sort();
  const missing = all.filter((k) => !have.has(k));
  return {
    category,
    total: all.length,
    translated: all.length - missing.length,
    missing: missing.length,
    sample: missing.slice(0, Math.max(0, sampleSize)),
  };
}

/** The OR-ed `key=` clauses for `keys`, chunked by length; `^` keys are left out. */
export function keyClauses(
  keys: Iterable<string>,
  maxChars: number = I18N_LIMITS.keyQueryChars,
): { clauses: string[]; skipped: string[] } {
  const clauses: string[] = [];
  const skipped: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const k of keys) {
    if (k.includes("^") || /[\r\n]/.test(k)) {
      skipped.push(k);
      continue;
    }
    const term = `key=${k}`;
    if (current.length && size + term.length + 3 > maxChars) {
      clauses.push(current.join("^OR"));
      current = [];
      size = 0;
    }
    current.push(term);
    size += term.length + 3;
  }
  if (current.length) clauses.push(current.join("^OR"));
  return { clauses, skipped };
}

const chunks = <T>(items: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Read `table` once per query clause; undefined (and a caveat) when any read
 * fails. `truncated` when a read stopped at SN_MAX_RECORDS.
 */
async function readAll(
  table: string,
  clauses: string[],
  fields: string[],
  caveats: string[],
): Promise<{ rows: SnRecord[]; truncated: boolean } | undefined> {
  const rows: SnRecord[] = [];
  let truncated = false;
  for (const query of clauses) {
    throwIfCancelled();
    try {
      const res = await queryTable({
        table,
        query,
        fields,
        displayValue: "false",
        fetchAll: true,
      });
      rows.push(...res.records);
      if (res.truncated) truncated = true;
    } catch (e) {
      rethrowIfCancelled(e);
      caveats.push(`i18n: ${table} could not be read: ${message(e)}`);
      return undefined;
    }
  }
  if (truncated) {
    caveats.push(
      `i18n: ${table} stopped at SN_MAX_RECORDS; its coverage is partial.`,
    );
  }
  return { rows, truncated };
}

interface SourceRead {
  source: I18nSource;
  keys: string[];
  rows: I18nRow[];
}

const skipped = (category: I18nCategory, table: string): SourceRead => ({
  source: { category, table, status: "skipped", keys: 0, rows: 0 },
  keys: [],
  rows: [],
});

/** A source read whose keys are every key seen in its rows. */
async function readSource(
  category: I18nCategory,
  table: string,
  clauses: string[],
  fields: string[],
  keyOf: (row: SnRecord) => string,
  caveats: string[],
): Promise<SourceRead> {
  if (!clauses.length) {
    return {
      source: { category, table, status: "read", keys: 0, rows: 0 },
      keys: [],
      rows: [],
    };
  }
  const read = await readAll(table, clauses, fields, caveats);
  if (!read) {
    return {
      source: { category, table, status: "unreadable", keys: 0, rows: 0 },
      keys: [],
      rows: [],
    };
  }
  const rows = read.rows
    .map((r) => ({ key: keyOf(r), language: str(r, "language") }))
    .filter((r) => r.key && r.language);
  const keys = [...new Set(rows.map((r) => r.key))];
  return {
    source: {
      category,
      table,
      status: "read",
      keys: keys.length,
      rows: rows.length,
      ...(read.truncated ? { truncated: true as const } : {}),
    },
    keys,
    rows,
  };
}

/** The scope's table names (sys_db_object); undefined when unreadable. */
async function scopeTables(
  scope: string,
  caveats: string[],
): Promise<string[] | undefined> {
  const read = await readAll(
    "sys_db_object",
    [scopeClause("sys_scope", scope)],
    ["name"],
    caveats,
  );
  if (!read) return undefined;
  return [
    ...new Set(read.rows.map((r) => str(r, "name")).filter(Boolean)),
  ].filter((t) => SAFE_TABLE.test(t));
}

/** The UIB strings of the macroponents: composition literals plus declared. */
async function uibStrings(
  opts: I18nCoverageOptions,
  caveats: string[],
): Promise<{ texts: string[]; count: number } | undefined> {
  const ids = (opts.macroponents ?? []).filter((id) => isSysIdAnyCase(id));
  if (opts.macroponents?.length && ids.length < opts.macroponents.length) {
    caveats.push(
      `i18n: ${opts.macroponents.length - ids.length} macroponent id(s) are not sys_ids and are ignored.`,
    );
  }
  const clauses = ids.length
    ? chunks(
        ids.slice(0, I18N_LIMITS.macroponents),
        I18N_LIMITS.tablesPerRead,
      ).map((c) => `sys_idIN${c.join(",")}`)
    : opts.scope && !opts.macroponents?.length
      ? [scopeClause("sys_scope", opts.scope)]
      : [];
  if (ids.length > I18N_LIMITS.macroponents) {
    caveats.push(
      `i18n: only the first ${I18N_LIMITS.macroponents} macroponents are checked.`,
    );
  }
  if (!clauses.length) return { texts: [], count: 0 };
  const read = await readAll(
    "sys_ux_macroponent",
    clauses,
    ["sys_id", "name", "composition", "required_translations"],
    caveats,
  );
  if (!read) return undefined;
  const texts = new Set<string>();
  let undecoded = 0;
  for (const row of read.rows) {
    const comp = decodeField(
      "uib-composition",
      str(row, "composition") || "[]",
    );
    const rawDeclared = str(row, "required_translations");
    const declared = rawDeclared.trim()
      ? decodeField("json", rawDeclared)
      : { decoded: true as const, value: [] };
    if (!comp.decoded) undecoded++;
    const t = requiredTranslations(
      comp.decoded ? comp.value : [],
      declared.decoded ? declared.value : [],
    );
    for (const s of t.texts) texts.add(s);
    for (const s of t.declared ?? []) texts.add(s);
    if (t.omitted) {
      caveats.push(
        `i18n: macroponent ${str(row, "name") || str(row, "sys_id")} has more than ${t.texts.length} strings; the rest are not checked.`,
      );
    }
  }
  if (undecoded) {
    caveats.push(
      `i18n: ${undecoded} macroponent composition(s) did not decode; their strings are not checked.`,
    );
  }
  return { texts: [...texts].sort(), count: read.rows.length };
}

/** The UIB strings against sys_ui_message keys in any scope. */
async function readUib(
  opts: I18nCoverageOptions,
  caveats: string[],
): Promise<{ read: SourceRead; count: number }> {
  const table = "sys_ui_message";
  if (!opts.macroponents?.length && !opts.scope) {
    return { read: skipped("uibStrings", table), count: 0 };
  }
  const strings = await uibStrings(opts, caveats);
  if (!strings) {
    return {
      read: {
        source: {
          category: "uibStrings",
          table: "sys_ux_macroponent",
          status: "unreadable",
          keys: 0,
          rows: 0,
        },
        keys: [],
        rows: [],
      },
      count: 0,
    };
  }
  const { clauses, skipped: unqueryable } = keyClauses(strings.texts);
  if (unqueryable.length) {
    caveats.push(
      `i18n: ${unqueryable.length} UIB string(s) contain '^' or a line break and cannot be matched in an encoded query; they are left out.`,
    );
  }
  const keys = strings.texts.filter((t) => !unqueryable.includes(t));
  const read = await readSource(
    "uibStrings",
    table,
    clauses,
    ["key", "language"],
    (r) => str(r, "key"),
    caveats,
  );
  if (read.source.status === "unreadable")
    return { read, count: strings.count };
  const wanted = new Set(keys);
  return {
    read: {
      source: { ...read.source, keys: keys.length },
      keys,
      rows: read.rows.filter((r) => wanted.has(r.key)),
    },
    count: strings.count,
  };
}

/** The scope's message, label, choice and translated-text sources. */
async function readScopeSources(
  scope: string | undefined,
  caveats: string[],
): Promise<SourceRead[]> {
  const SOURCES: [I18nCategory, string][] = [
    ["messages", "sys_ui_message"],
    ["labels", "sys_documentation"],
    ["choices", "sys_choice"],
    ["translatedText", "sys_translated_text"],
    ["translatedFields", "sys_translated"],
  ];
  if (!scope) return SOURCES.map(([c, t]) => skipped(c, t));
  const out: SourceRead[] = [
    await readSource(
      "messages",
      "sys_ui_message",
      [scopeClause("sys_scope", scope)],
      ["key", "language"],
      (r) => str(r, "key"),
      caveats,
    ),
  ];
  const tables = await scopeTables(scope, caveats);
  if (!tables) {
    for (const [c, t] of SOURCES.slice(1)) {
      out.push({
        source: {
          category: c,
          table: t,
          status: "unreadable",
          keys: 0,
          rows: 0,
        },
        keys: [],
        rows: [],
      });
    }
    caveats.push(
      "i18n: without the scope's tables (sys_db_object) labels, choices, translated text and translated fields are not checked.",
    );
    return out;
  }
  const inClauses = (field: string) =>
    chunks(tables, I18N_LIMITS.tablesPerRead).map(
      (c) => `${field}IN${c.join(",")}`,
    );
  out.push(
    await readSource(
      "labels",
      "sys_documentation",
      inClauses("name"),
      ["name", "element", "language"],
      (r) =>
        str(r, "element")
          ? `${str(r, "name")}.${str(r, "element")}`
          : str(r, "name"),
      caveats,
    ),
    await readSource(
      "choices",
      "sys_choice",
      inClauses("name"),
      ["name", "element", "value", "language"],
      (r) => `${str(r, "name")}.${str(r, "element")}.${str(r, "value")}`,
      caveats,
    ),
    await readSource(
      "translatedText",
      "sys_translated_text",
      inClauses("tablename"),
      ["tablename", "fieldname", "documentkey", "language"],
      (r) =>
        `${str(r, "tablename")}.${str(r, "fieldname")}.${str(r, "documentkey")}`,
      caveats,
    ),
    await readSource(
      "translatedFields",
      "sys_translated",
      inClauses("name"),
      ["name", "element", "value", "language"],
      (r) => `${str(r, "name")}.${str(r, "element")}.${str(r, "value")}`,
      caveats,
    ),
  );
  return out;
}

/** The target languages: given, active sys_language rows, or observed. */
async function targetLanguages(
  opts: I18nCoverageOptions,
  base: string,
  reads: SourceRead[],
  caveats: string[],
): Promise<{
  languages: { language: string; name?: string }[];
  source: I18nCoverageReport["languageSource"];
}> {
  if (opts.languages?.length) {
    const valid = [
      ...new Set(opts.languages.map(lang).filter((l) => LANGUAGE.test(l))),
    ];
    if (valid.length < opts.languages.length) {
      caveats.push("i18n: invalid or duplicate language codes were ignored.");
    }
    return {
      languages: valid.map((language) => ({ language })),
      source: "given",
    };
  }
  const read = await readAll(
    "sys_language",
    ["active=true^ORDERBYid"],
    ["id", "name"],
    caveats,
  );
  if (read) {
    const languages = read.rows
      .map((r) => ({ language: lang(str(r, "id")), name: str(r, "name") }))
      .filter((l) => LANGUAGE.test(l.language) && l.language !== base)
      .map((l) => (l.name ? l : { language: l.language }));
    return { languages, source: "sys_language" };
  }
  const seen = new Set<string>();
  for (const r of reads) for (const row of r.rows) seen.add(lang(row.language));
  seen.delete(base);
  caveats.push(
    "i18n: active languages (sys_language) could not be read; the languages found in the translation rows are reported.",
  );
  return {
    languages: [...seen]
      .filter((l) => LANGUAGE.test(l))
      .sort()
      .map((language) => ({ language })),
    source: "observed",
  };
}

/**
 * Build the translation coverage report. Needs a scope or macroponents;
 * never throws otherwise except on a cancel.
 */
export async function i18nCoverage(
  opts: I18nCoverageOptions,
): Promise<I18nCoverageReport> {
  const scope = opts.scope?.trim() || undefined;
  if (!scope && !opts.macroponents?.length) {
    throw new ServiceNowError(
      "Translation coverage needs a scope or macroponent sys_ids.",
      400,
    );
  }
  const base = lang(opts.baseLanguage || "en");
  const sampleSize = Math.min(
    Math.max(0, Math.floor(opts.sampleSize ?? I18N_LIMITS.sample)),
    I18N_LIMITS.sampleMax,
  );
  const caveats: string[] = [];
  const reads = await readScopeSources(scope, caveats);
  const uib = await readUib({ ...opts, scope }, caveats);
  reads.push(uib.read);
  const { languages, source } = await targetLanguages(
    opts,
    base,
    reads,
    caveats,
  );
  const readable = reads.filter((r) => r.source.status === "read");
  const coverage: I18nLanguageCoverage[] = languages.map((l) => {
    const categories = readable.map((r) =>
      categoryCoverage(
        r.source.category,
        r.keys,
        r.rows,
        l.language,
        sampleSize,
      ),
    );
    const sum = (k: "total" | "translated" | "missing") =>
      categories.reduce((n, c) => n + c[k], 0);
    return {
      language: l.language,
      ...(l.name ? { name: l.name } : {}),
      total: sum("total"),
      translated: sum("translated"),
      missing: sum("missing"),
      categories,
    };
  });
  if (!languages.length) {
    caveats.push("i18n: no target language; nothing to measure.");
  }
  caveats.push(I18N_CAVEAT);
  return {
    ...(scope ? { scope } : {}),
    macroponents: uib.count,
    baseLanguage: base,
    languageSource: source,
    sources: reads.map((r) => r.source),
    languages: coverage,
    caveats,
  };
}

const CATEGORY_LABEL: Record<I18nCategory, string> = {
  messages: "UI messages",
  labels: "Field labels",
  choices: "Choices",
  translatedText: "Translated text",
  translatedFields: "Translated fields",
  uibStrings: "UIB strings",
};

const pct = (translated: number, total: number): string =>
  total ? `${Math.floor((translated / total) * 100)} %` : "—";

const code = (s: string): string => `\`${s.replaceAll("`", "'")}\``;

/** The report as Markdown. */
export function i18nCoverageMarkdown(report: I18nCoverageReport): string {
  return ["# Translation coverage", "", ...i18nCoverageSections(report)].join(
    "\n",
  );
}

/** The report body below the title: summary line, sources, coverage, missing keys, caveats. */
export function i18nCoverageSections(report: I18nCoverageReport): string[] {
  const md: string[] = [
    [
      report.scope ? `Scope ${code(report.scope)}` : undefined,
      report.macroponents ? `${report.macroponents} macroponent(s)` : undefined,
      `base language ${code(report.baseLanguage)}`,
      `languages from ${report.languageSource}`,
    ]
      .filter(Boolean)
      .join(" · ") + ".",
    "",
    "## Sources",
    "",
    mdTable(
      ["Category", "Table", "Status", "Keys", "Rows"],
      report.sources.map((s) => [
        CATEGORY_LABEL[s.category],
        s.table,
        s.truncated ? `${s.status} (truncated)` : s.status,
        String(s.keys),
        String(s.rows),
      ]),
    ),
    "",
  ];
  if (report.languages.length) {
    md.push(
      "## Coverage",
      "",
      mdTable(
        ["Language", "Translated", "Missing", "Total", "Coverage"],
        report.languages.map((l) => [
          l.name ? `${l.language} (${l.name})` : l.language,
          String(l.translated),
          String(l.missing),
          String(l.total),
          pct(l.translated, l.total),
        ]),
      ),
      "",
    );
  }
  for (const l of report.languages) {
    if (!l.missing) continue;
    md.push(`## Missing: ${mdEscape(l.language)}`, "");
    for (const c of l.categories) {
      if (!c.missing) continue;
      const more = c.missing - c.sample.length;
      md.push(
        `- ${CATEGORY_LABEL[c.category]}: ${c.missing} of ${c.total}${
          c.sample.length ? ` — ${c.sample.map(code).join(", ")}` : ""
        }${more > 0 ? ` (+${more} more)` : ""}`,
      );
    }
    md.push("");
  }
  if (report.caveats.length) {
    md.push("## Caveats", "", ...report.caveats.map((c) => `- ${c}`), "");
  }
  return md;
}
