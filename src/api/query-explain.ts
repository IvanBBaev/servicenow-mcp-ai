/**
 * N-15 (NX-19) — a static explain of an encoded query against a table's
 * indexes: which conditions can use an index, which force a scan, and the
 * cost notes for ORDERBY / LIKE / STARTSWITH. Pure: it sends no request; the
 * indexes come from describeTableIndexes.
 *
 * The rules are the database's usual ones, not ServiceNow's planner (which is
 * not exposed): a condition can use an index when its field is the leading
 * column of one and its operator is sargable. The verdict is advice, not a
 * plan.
 */

export interface TableIndex {
  name: string;
  /** Table the index is defined on (a parent in the chain for extensions). */
  table: string;
  /** Indexed columns, in order. */
  fields: string[];
  unique: boolean;
}

export interface ExplainedCondition {
  /** 0-based `^NQ` block the condition belongs to. */
  block: number;
  field: string;
  operator: string;
  /** True for an `^OR` condition (joined with the previous one). */
  or: boolean;
  /** An index whose leading column is the field, when the operator can use it. */
  index?: string;
  indexed: boolean;
  note?: string;
}

export interface QueryExplain {
  conditions: ExplainedCondition[];
  orderBy: { field: string; desc: boolean; indexed: boolean }[];
  /** Plain-language cost notes, worst first. */
  notes: string[];
  /** Every block has at least one indexed AND condition (or none filters). */
  indexFriendly: boolean;
}

/** Operators, longest first so a prefix never shadows a longer one. */
const OPERATORS = [
  "NOT IN",
  "NOTLIKE",
  "NOTSAMEAS",
  "NOTEMPTY",
  "ISNOTEMPTY",
  "ISEMPTY",
  "ANYTHING",
  "EMPTYSTRING",
  "STARTSWITH",
  "ENDSWITH",
  "DOESNOTCONTAIN",
  "CONTAINS",
  "BETWEEN",
  "DATEPART",
  "RELATIVEGT",
  "RELATIVELT",
  "RELATIVEGE",
  "RELATIVELE",
  "MORETHAN",
  "LESSTHAN",
  "DYNAMIC",
  "SAMEAS",
  "NOTON",
  "LIKE",
  "IN",
  "ON",
  "!=",
  ">=",
  "<=",
  "=",
  ">",
  "<",
] as const;

/** Operators an index on the field can serve. */
const SARGABLE = new Set([
  "=",
  "IN",
  "STARTSWITH",
  ">",
  "<",
  ">=",
  "<=",
  "BETWEEN",
  "ON",
  "RELATIVEGT",
  "RELATIVELT",
  "RELATIVEGE",
  "RELATIVELE",
  "MORETHAN",
  "LESSTHAN",
  "ISEMPTY",
  "DYNAMIC",
]);

const LEADING_WILDCARD = new Set([
  "LIKE",
  "NOTLIKE",
  "CONTAINS",
  "DOESNOTCONTAIN",
  "ENDSWITH",
]);

/** Fields every table indexes (primary key). */
const ALWAYS_INDEXED = new Set(["sys_id"]);

const FIELD_RE = /^[a-z0-9_.$]+/;

interface Parsed {
  field: string;
  operator: string;
}

function parseCondition(term: string): Parsed | undefined {
  const m = FIELD_RE.exec(term);
  if (!m) return undefined;
  const field = m[0];
  const rest = term.slice(field.length);
  const operator = OPERATORS.find((op) => rest.startsWith(op));
  return operator ? { field, operator } : undefined;
}

/**
 * Explain `query` against `indexes`. Unparseable terms (javascript:, a
 * keyword search such as `123TEXTQUERY321`) are reported as a note, never
 * thrown on.
 */
export function explainQuery(
  query: string,
  indexes: readonly TableIndex[],
): QueryExplain {
  const leading = new Map<string, string>();
  for (const ix of indexes) {
    const first = ix.fields[0];
    if (first && !leading.has(first)) leading.set(first, ix.name);
  }
  const secondary = new Set(indexes.flatMap((ix) => ix.fields.slice(1)));

  const conditions: ExplainedCondition[] = [];
  const orderBy: QueryExplain["orderBy"] = [];
  const notes = new Set<string>();
  const unparsed: string[] = [];

  const blocks = query.split("^NQ");
  blocks.forEach((blockText, block) => {
    for (const raw of blockText.split("^")) {
      let term = raw.trim();
      if (!term || term === "EQ") continue;
      if (term.startsWith("ORDERBYDESC") || term.startsWith("ORDERBY")) {
        const desc = term.startsWith("ORDERBYDESC");
        const field = term.slice(desc ? 11 : 7);
        const indexed = ALWAYS_INDEXED.has(field) || leading.has(field);
        orderBy.push({ field, desc, indexed });
        continue;
      }
      if (term.startsWith("GROUPBY")) continue;
      const or = term.startsWith("OR") && FIELD_RE.test(term.slice(2));
      if (or) term = term.slice(2);
      const parsed = parseCondition(term);
      if (!parsed) {
        unparsed.push(raw);
        continue;
      }
      const { field, operator } = parsed;
      const dotWalk = field.includes(".");
      const sargable = SARGABLE.has(operator);
      const index = ALWAYS_INDEXED.has(field) ? "sys_id" : leading.get(field);
      const indexed = !dotWalk && sargable && index !== undefined;
      let note: string | undefined;
      if (dotWalk) {
        note = "dot-walked: a join to the referenced table, filtered there";
      } else if (LEADING_WILDCARD.has(operator)) {
        note = `${operator} cannot use an index (wildcard before the value)`;
      } else if (!sargable) {
        note = `${operator} cannot use an index`;
      } else if (index === undefined && secondary.has(field)) {
        note = "only a non-leading column of a composite index";
      } else if (index === undefined) {
        note = "no index on this field";
      } else if (operator === "STARTSWITH") {
        note = "index range scan (prefix match)";
      }
      conditions.push({
        block,
        field,
        operator,
        or,
        ...(indexed ? { index } : {}),
        indexed,
        ...(note ? { note } : {}),
      });
    }
  });

  const filtering = conditions.filter((c) => c.operator !== "ANYTHING");
  const blockFriendly = blocks.map((_, b) => {
    const inBlock = filtering.filter((c) => c.block === b);
    if (inBlock.length === 0) return true;
    // An AND condition on an index narrows the block, unless an OR on the
    // same group pulls an unindexed condition in.
    const groups: ExplainedCondition[][] = [];
    for (const c of inBlock) {
      if (c.or && groups.length) groups[groups.length - 1]!.push(c);
      else groups.push([c]);
    }
    return groups.some((g) => g.every((c) => c.indexed));
  });
  const indexFriendly = blockFriendly.every(Boolean);

  if (!indexFriendly) {
    const bad = blockFriendly
      .map((ok, b) => (ok ? -1 : b))
      .filter((b) => b >= 0);
    notes.add(
      blocks.length > 1
        ? `No indexed condition narrows block(s) ${bad.join(", ")}: each ^NQ block is a separate query, so one unindexed block scans the table.`
        : "No condition can use an index: the query scans the table.",
    );
  }
  if (
    filtering.some((c) => c.or) &&
    filtering.some((c) => c.or && !c.indexed)
  ) {
    notes.add(
      "An ^OR with an unindexed side cannot use the other side's index.",
    );
  }
  if (filtering.some((c) => LEADING_WILDCARD.has(c.operator))) {
    notes.add(
      "LIKE / CONTAINS / ENDSWITH match inside the value and read every row the other conditions leave; prefer STARTSWITH or = on an indexed field.",
    );
  }
  if (filtering.some((c) => c.operator === "STARTSWITH" && c.indexed)) {
    notes.add("STARTSWITH on an indexed field is an index range scan.");
  }
  const unsorted = orderBy.filter((o) => !o.indexed);
  if (unsorted.length) {
    notes.add(
      `ORDERBY ${unsorted.map((o) => o.field).join(", ")} has no index: the matching rows are sorted after the read; on a large result set add a selective indexed condition.`,
    );
  }
  if (filtering.some((c) => c.field.includes("."))) {
    notes.add(
      "Dot-walked conditions join the referenced table; keep at least one indexed condition on this table.",
    );
  }
  if (unparsed.length) {
    notes.add(
      `Not explained (unrecognised terms): ${unparsed.slice(0, 5).join(", ")}${unparsed.length > 5 ? ", …" : ""}.`,
    );
  }

  return { conditions, orderBy, notes: [...notes], indexFriendly };
}

/** One condition of an encoded query, with its value (N-30). */
export interface EncodedQueryTerm {
  /** 0-based `^NQ` block the condition belongs to. */
  block: number;
  field: string;
  operator: string;
  /** Raw value after the operator (`@`-joined for BETWEEN / DATEPART). */
  value: string;
  /** True for an `^OR` condition (joined with the previous one). */
  or: boolean;
}

export interface EncodedQueryRead {
  terms: EncodedQueryTerm[];
  orderBy: { field: string; desc: boolean }[];
  groupBy: string[];
  /** Terms the reader did not recognise (javascript:, keyword search…). */
  unparsed: string[];
}

/**
 * N-30 — read an encoded query into its conditions, values included. Pure and
 * tolerant: an unknown term lands in `unparsed`, never thrown on. Values are
 * echoed as stored (a DYNAMIC value is the sys_id of a dynamic filter option).
 */
export function readEncodedQuery(query: string): EncodedQueryRead {
  const out: EncodedQueryRead = {
    terms: [],
    orderBy: [],
    groupBy: [],
    unparsed: [],
  };
  query.split("^NQ").forEach((blockText, block) => {
    for (const raw of blockText.split("^")) {
      let term = raw.trim();
      if (!term || term === "EQ") continue;
      if (term.startsWith("ORDERBYDESC") || term.startsWith("ORDERBY")) {
        const desc = term.startsWith("ORDERBYDESC");
        out.orderBy.push({ field: term.slice(desc ? 11 : 7), desc });
        continue;
      }
      if (term.startsWith("GROUPBY")) {
        out.groupBy.push(term.slice(7));
        continue;
      }
      const or = term.startsWith("OR") && FIELD_RE.test(term.slice(2));
      if (or) term = term.slice(2);
      const parsed = parseCondition(term);
      if (!parsed) {
        out.unparsed.push(raw);
        continue;
      }
      out.terms.push({
        block,
        field: parsed.field,
        operator: parsed.operator,
        value: term.slice(parsed.field.length + parsed.operator.length),
        or,
      });
    }
  });
  return out;
}
