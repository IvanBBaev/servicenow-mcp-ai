import type { SnRecord } from "../api/table.js";

/**
 * Render records as RFC-4180 CSV for a spreadsheet-friendly export — a pure,
 * dependency-free formatter (XLSX would need a binary writer, so it is out of
 * scope for the zero-dependency build). Columns are the requested `fields`, or
 * the union of keys across the records when none are given. Values containing a
 * comma, quote or newline are quoted with inner quotes doubled; objects (e.g.
 * a `{ value, display_value }` field) are JSON-encoded so a row never breaks.
 *
 * H-5 (L2-01) — a text cell a spreadsheet would evaluate as a formula (it
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return, ignoring leading
 * spaces) is neutralised OWASP-style with a leading `'`. The trade-off is that
 * a negative number stored as text (`"-5"`) is exported as `'-5`; operators
 * who need raw values set SN_CSV_FORMULA_GUARD=0. `bom` prepends a UTF-8 BOM
 * so Excel on Windows decodes non-ASCII text correctly.
 */
export interface CsvOptions {
  /** Prefix formula-like text cells with `'` (default true). */
  formulaGuard?: boolean;
  /** Prepend a UTF-8 byte-order mark (default false). */
  bom?: boolean;
  /**
   * Emit the header row (default true). S-11 streams a file export page by
   * page: the first page carries the header, later pages pass `false` with
   * the same `fields` so the columns line up.
   */
  header?: boolean;
}

export interface CsvRender {
  csv: string;
  /** Cells the formula guard neutralised. */
  escaped: number;
  bom: boolean;
}

const FORMULA_START = /^[=+\-@\t\r]/;

function isFormulaLike(s: string): boolean {
  return FORMULA_START.test(s) || FORMULA_START.test(s.trimStart());
}

export function renderCsv(
  records: SnRecord[],
  fields?: string[],
  options: CsvOptions = {},
): CsvRender {
  const guard = options.formulaGuard ?? true;
  const bom = options.bom ?? false;
  const columns =
    fields && fields.length > 0
      ? fields
      : [...new Set(records.flatMap((r) => Object.keys(r)))];

  let escaped = 0;
  const cell = (value: unknown): string => {
    let s: string;
    if (value == null) s = "";
    else if (typeof value === "string") {
      s = value;
      if (guard && isFormulaLike(s)) {
        s = `'${s}`;
        escaped++;
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      s = String(value);
    } else s = JSON.stringify(value); // object/array (SN display_value fields)
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  const lines = options.header === false ? [] : [columns.map(cell).join(",")];
  for (const record of records) {
    lines.push(columns.map((c) => cell(record[c])).join(","));
  }
  return { csv: (bom ? "﻿" : "") + lines.join("\n"), escaped, bom };
}

/** The CSV text alone (formula guard on, no BOM unless asked). */
export function toCsv(
  records: SnRecord[],
  fields?: string[],
  options: CsvOptions = {},
): string {
  return renderCsv(records, fields, options).csv;
}
