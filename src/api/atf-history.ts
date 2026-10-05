import { ServiceNowError } from "../core/errors.js";
import { unreadableReason } from "./security.js";
import { mdTable, snString } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * N-16 (NX-20) — ATF result history: per test and per suite, the last result,
 * the pass rate over the last `window` runs and a `flaky` flag.
 *
 * - tests: the sys_atf_test_result rows of the given tests (status, start /
 *   end time, run time and the suite result they belong to, `parent`) in one
 *   bounded `testIN…` query, newest first;
 * - suites: the sys_atf_test_suite_result rows of the given suites, the same
 *   way (`test_suite IN…`);
 * - {@link summariseResults} turns one test's or suite's rows into a summary:
 *   `success` counts as a pass, `failure` / `error` as a fail, anything else
 *   (skipped, cancelled, running, waiting) is neither and does not enter the
 *   pass rate or the flip count. A run is `flaky` when the window holds both
 *   a pass and a fail and the outcome flips at least {@link FLAKY_MIN_FLIPS}
 *   times (oldest to newest) — one flip is a plain break or fix.
 *
 * Not wired to a tool yet: `with_results:true` on `servicenow_list_atf_tests`
 * / `servicenow_list_atf_suites` grows tools/list (O-10). Wiring is
 * `withAtfResults(items, (await atfResultHistory({ testIds })).tests)`.
 *
 * Read-only and bounded; never throws except on a cancel. A failed read
 * degrades to `available:false` with a reason, per section. Table, field and
 * choice names (sys_atf_test_result test / parent / run_time,
 * sys_atf_test_suite_result test_suite, the status values) are unverified
 * until O-5 (PDI). "Unchanged test" (a stable sys_mod_count across the
 * window, the NX-20 refinement) is not checked yet.
 */

/** Runs per test or suite looked at, by default. */
export const DEFAULT_WINDOW = 20;
/** Largest window accepted. */
export const MAX_WINDOW = 100;
/** Ids accepted per call (tests or suites, each). */
export const MAX_IDS = 100;
/** Rows read per section (one query); `window × ids` is capped here. */
export const HISTORY_ROW_LIMIT = 2_000;
/**
 * Pass / fail flips within the window at which a test with both outcomes is
 * flaky. One flip is a single break (or fix); two mean it went back again.
 */
export const FLAKY_MIN_FLIPS = 2;

export type AtfOutcome = "pass" | "fail" | "other";

export interface AtfResultRow {
  /** The raw status value (`success`, `failure`, `error`, `skipped`, …). */
  status: string;
  startTime: string;
  endTime?: string;
  runTime?: string;
  /** The suite result a test result belongs to (tests only). */
  suiteResult?: string;
}

export interface AtfLastResult {
  status: string;
  outcome: AtfOutcome;
  /** Start time of the newest run. */
  at: string;
  endTime?: string;
  runTime?: string;
  suiteResult?: string;
}

export interface AtfResultSummary {
  /** Runs inside the window. */
  runs: number;
  passed: number;
  failed: number;
  /** Neither pass nor fail (skipped, cancelled, still running …). */
  other: number;
  /** passed / (passed + failed); null when no run passed or failed. */
  passRate: number | null;
  /** Pass ↔ fail changes, oldest to newest, ignoring `other` runs. */
  flips: number;
  flaky: boolean;
  /** The newest run; absent when there is none. */
  last?: AtfLastResult;
}

export interface Unavailable {
  available: false;
  unavailableReason: string;
}

export interface AtfHistorySection {
  available: true;
  /** sys_id → summary; every requested id is present (runs 0 when never run). */
  summaries: Record<string, AtfResultSummary>;
  /** Rows read. */
  scanned: number;
  /** True when the read hit its row limit: older runs may be missing. */
  truncated: boolean;
}

export interface AtfResultHistory {
  window: number;
  tests?: AtfHistorySection | Unavailable;
  suites?: AtfHistorySection | Unavailable;
}

const isCancel = (e: unknown): boolean =>
  e instanceof ServiceNowError && e.code === "CANCELLED";

const unavailable = (reason: string): Unavailable => ({
  available: false,
  unavailableReason: reason,
});

const SYS_ID = /^[0-9a-f]{32}$/;

/** Outcome of a status value or label. */
export function outcomeOf(status: string): AtfOutcome {
  const s = status.trim();
  if (/^(success|successful|pass(ed)?)$/i.test(s)) return "pass";
  if (/^(fail(ure|ed)?|error)$/i.test(s)) return "fail";
  return "other";
}

/** Clamp a window to 1…MAX_WINDOW (non-numbers fall back to the default). */
export function clampWindow(window: number | undefined): number {
  if (window === undefined || !Number.isFinite(window)) return DEFAULT_WINDOW;
  return Math.min(MAX_WINDOW, Math.max(1, Math.floor(window)));
}

/**
 * Summarise one test's or suite's runs. `rows` may come in any order; they
 * are sorted newest first by start time and only the newest `window` count.
 */
export function summariseResults(
  rows: readonly AtfResultRow[],
  window: number = DEFAULT_WINDOW,
): AtfResultSummary {
  const recent = [...rows]
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .slice(0, clampWindow(window));
  let passed = 0;
  let failed = 0;
  let flips = 0;
  let previous: AtfOutcome | undefined;
  // Oldest to newest, so a flip reads as "was X, became Y".
  for (let i = recent.length - 1; i >= 0; i--) {
    const outcome = outcomeOf(recent[i]!.status);
    if (outcome === "other") continue;
    if (outcome === "pass") passed++;
    else failed++;
    if (previous && previous !== outcome) flips++;
    previous = outcome;
  }
  const decided = passed + failed;
  const newest = recent[0];
  return {
    runs: recent.length,
    passed,
    failed,
    other: recent.length - decided,
    passRate: decided === 0 ? null : passed / decided,
    flips,
    flaky: passed > 0 && failed > 0 && flips >= FLAKY_MIN_FLIPS,
    ...(newest
      ? {
          last: {
            status: newest.status,
            outcome: outcomeOf(newest.status),
            at: newest.startTime,
            ...(newest.endTime ? { endTime: newest.endTime } : {}),
            ...(newest.runTime ? { runTime: newest.runTime } : {}),
            ...(newest.suiteResult ? { suiteResult: newest.suiteResult } : {}),
          },
        }
      : {}),
  };
}

interface SectionSpec {
  table: string;
  /** The reference field to the test or suite. */
  key: string;
  /** Extra fields read. */
  fields: string[];
  toRow: (r: Record<string, unknown>) => AtfResultRow;
}

const TEST_SPEC: SectionSpec = {
  table: "sys_atf_test_result",
  key: "test",
  fields: ["parent"],
  toRow: (r) => ({
    ...baseRow(r),
    ...(snString(r.parent) ? { suiteResult: snString(r.parent) } : {}),
  }),
};

const SUITE_SPEC: SectionSpec = {
  table: "sys_atf_test_suite_result",
  key: "test_suite",
  fields: [],
  toRow: (r) => baseRow(r),
};

function baseRow(r: Record<string, unknown>): AtfResultRow {
  const endTime = snString(r.end_time);
  const runTime = snString(r.run_time);
  return {
    status: snString(r.status),
    startTime: snString(r.start_time),
    ...(endTime ? { endTime } : {}),
    ...(runTime ? { runTime } : {}),
  };
}

/** Distinct, valid sys_ids (at most MAX_IDS), or the reason they are not. */
function cleanIds(ids: readonly string[]): string[] | string {
  const out = [...new Set(ids.map((id) => id.trim()))];
  const bad = out.find((id) => !SYS_ID.test(id));
  if (bad !== undefined) return `"${bad}" is not a sys_id.`;
  if (out.length > MAX_IDS) return `At most ${MAX_IDS} ids per call.`;
  return out;
}

async function readSection(
  spec: SectionSpec,
  rawIds: readonly string[],
  window: number,
): Promise<AtfHistorySection | Unavailable> {
  const ids = cleanIds(rawIds);
  if (typeof ids === "string") return unavailable(ids);
  if (ids.length === 0) {
    return { available: true, summaries: {}, scanned: 0, truncated: false };
  }
  const limit = Math.min(ids.length * window, HISTORY_ROW_LIMIT);
  let records: Record<string, unknown>[];
  try {
    ({ records } = await queryTable({
      table: spec.table,
      query: `${spec.key}IN${ids.join(",")}^ORDERBYDESCstart_time`,
      fields: [
        "sys_id",
        spec.key,
        "status",
        "start_time",
        "end_time",
        "run_time",
        ...spec.fields,
      ],
      displayValue: "false",
      limit,
    }));
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason(spec.table, e));
  }
  const byId = new Map<string, AtfResultRow[]>(ids.map((id) => [id, []]));
  for (const r of records) {
    byId.get(snString(r[spec.key]))?.push(spec.toRow(r));
  }
  const summaries: Record<string, AtfResultSummary> = {};
  for (const [id, rows] of byId) summaries[id] = summariseResults(rows, window);
  return {
    available: true,
    summaries,
    scanned: records.length,
    truncated: records.length >= limit,
  };
}

/**
 * The result history of the given tests and / or suites. A section is
 * present only when its ids were given; each degrades on its own.
 */
export async function atfResultHistory({
  testIds,
  suiteIds,
  window,
}: {
  testIds?: readonly string[];
  suiteIds?: readonly string[];
  window?: number;
} = {}): Promise<AtfResultHistory> {
  const w = clampWindow(window);
  const out: AtfResultHistory = { window: w };
  if (testIds) out.tests = await readSection(TEST_SPEC, testIds, w);
  if (suiteIds) out.suites = await readSection(SUITE_SPEC, suiteIds, w);
  return out;
}

/**
 * Merge a section's summaries onto `listAtfTests` / `listAtfSuites` items
 * (`results`, by sys_id). An unavailable or missing section leaves the list
 * as it is; the caller reports the reason once.
 */
export function withAtfResults<T extends { sys_id?: string }>(
  list: readonly T[],
  history: AtfHistorySection | Unavailable | undefined,
): (T & { results?: AtfResultSummary })[] {
  if (!history?.available) return [...list];
  return list.map((item) => {
    const summary = item.sys_id ? history.summaries[item.sys_id] : undefined;
    return summary ? { ...item, results: summary } : { ...item };
  });
}

const UNVERIFIED =
  "_Table, field and choice names are unverified until O-5 (PDI)._";

const pct = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

function renderSection(
  title: string,
  section: AtfHistorySection | Unavailable,
  window: number,
  names: Record<string, string>,
): string[] {
  const out = [`## ${title}`, ""];
  if (!section.available) {
    return [...out, `Unavailable: ${section.unavailableReason}`, ""];
  }
  const entries = Object.entries(section.summaries);
  if (entries.length === 0) return [...out, "_None requested._", ""];
  const flaky = entries.filter(([, s]) => s.flaky).length;
  out.push(
    `${entries.length} item(s), last ${window} run(s) each; ${flaky} flaky${section.truncated ? " (row limit hit — older runs may be missing)" : ""}.`,
    "",
    mdTable(
      ["Name", "Last result", "Last run", "Pass rate", "Runs", "Flaky"],
      entries.map(([id, s]) => [
        names[id] ?? `\`${id}\``,
        s.last ? s.last.status || "(empty)" : "never run",
        s.last?.at ?? "",
        pct(s.passRate),
        String(s.runs),
        s.flaky ? `yes (${s.flips} flips)` : "no",
      ]),
    ),
    "",
  );
  return out;
}

/** Markdown for a result history; `names` maps sys_id → display name. */
export function renderAtfHistory(
  h: AtfResultHistory,
  names: Record<string, string> = {},
): string[] {
  const out: string[] = [];
  if (h.tests) out.push(...renderSection("Tests", h.tests, h.window, names));
  if (h.suites) out.push(...renderSection("Suites", h.suites, h.window, names));
  if (out.length === 0) return ["_No tests or suites requested._"];
  return [...out, UNVERIFIED];
}
