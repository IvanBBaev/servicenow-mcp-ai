import { rethrowIfCancelled } from "../core/errors.js";
import { snRequest } from "../core/http.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import { ARTIFACT_TYPES } from "../core/artifacts/registry.js";
import { toRun, waitForAtfRun } from "./atf.js";
import type { AtfRun, AtfWait, CicdResult } from "./atf.js";
import { pluginCall } from "./plugin.js";
import { assertNoCaret, expectResult, snString } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * N-3 (read) — the platform's own Instance Scan, read next to our lint: the
 * latest scan_result and its scan_finding rows (check, priority, target
 * record), each target table mapped to a registry artefact type, plus the
 * "both agree" set — records that Instance Scan and our lint both flag.
 *
 * The read never throws except on a cancel: a missing plugin or an
 * unreadable table gives `available: false`. Running a scan (phase D,
 * {@link runInstanceScan}) is a write behind the ATF rails.
 * Table and field names (scan_result, scan_finding, check.*, source_table,
 * source) are unverified until O-5 (PDI).
 */

export const SCAN_RESULT_TABLE = "scan_result";
export const SCAN_FINDING_TABLE = "scan_finding";
/** Findings read per run. */
export const INSTANCE_SCAN_LIMIT = 500;
/** Findings rendered in the Markdown table. */
const RENDER_TOP = 30;

export interface ScanFinding {
  check: string;
  priority: string;
  category?: string;
  table: string;
  sys_id: string;
  /** Registry artefact type of `table`, when registered. */
  artifactType?: string;
}

export interface InstanceScanReport {
  available: boolean;
  unavailableReason?: string;
  /** The scan_result read, when one exists. */
  result?: { sys_id: string; createdOn: string; state?: string };
  findingCount: number;
  /** True when the read hit INSTANCE_SCAN_LIMIT. */
  capped: boolean;
  byPriority: Record<string, number>;
  byArtifactType: Record<string, number>;
  findings: ScanFinding[];
  /** Records flagged by Instance Scan and by our lint (`table` / `sys_id`). */
  agreed: { table: string; sys_id: string; checks: string[] }[];
}

const TABLE_TO_TYPE = new Map<string, string>();
for (const t of ARTIFACT_TYPES) {
  if (!TABLE_TO_TYPE.has(t.table)) TABLE_TO_TYPE.set(t.table, t.type);
}

/** Registry artefact type for a table (first registered type wins). */
export function artifactTypeForTable(table: string): string | undefined {
  return TABLE_TO_TYPE.get(table);
}

/**
 * Records flagged by both sides, matched on sys_id (unique across tables);
 * `linted` holds our lint's flagged sys_ids.
 */
export function agreedFindings(
  findings: readonly ScanFinding[],
  linted: ReadonlySet<string>,
): InstanceScanReport["agreed"] {
  const by = new Map<string, InstanceScanReport["agreed"][number]>();
  for (const f of findings) {
    if (!f.sys_id || !linted.has(f.sys_id)) continue;
    const row = by.get(f.sys_id) ?? {
      table: f.table,
      sys_id: f.sys_id,
      checks: [],
    };
    if (!row.checks.includes(f.check)) row.checks.push(f.check);
    by.set(f.sys_id, row);
  }
  return [...by.values()];
}

function unavailable(reason: string): InstanceScanReport {
  return {
    available: false,
    unavailableReason: reason,
    findingCount: 0,
    capped: false,
    byPriority: {},
    byArtifactType: {},
    findings: [],
    agreed: [],
  };
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Read the latest scan result and its findings. `linted` is the set of
 * sys_ids our lint flagged in the same run (for the "both agree" set).
 */
export async function readInstanceScan(
  linted: ReadonlySet<string> = new Set(),
): Promise<InstanceScanReport> {
  let result: InstanceScanReport["result"];
  try {
    const { records } = await queryTable({
      table: SCAN_RESULT_TABLE,
      query: "ORDERBYDESCsys_created_on",
      fields: ["sys_id", "sys_created_on", "state"],
      displayValue: "false",
      limit: 1,
    });
    const r = records[0];
    if (r) {
      const state = snString(r.state);
      result = {
        sys_id: snString(r.sys_id),
        createdOn: snString(r.sys_created_on),
        ...(state ? { state } : {}),
      };
    }
  } catch (e) {
    rethrowIfCancelled(e);
    return unavailable(
      `${SCAN_RESULT_TABLE} could not be read (Instance Scan plugin missing or no read role): ${message(e)}`,
    );
  }

  let records: Record<string, unknown>[];
  try {
    ({ records } = await queryTable({
      table: SCAN_FINDING_TABLE,
      query: result ? `result=${result.sys_id}` : "active=true",
      fields: [
        "check.name",
        "check.priority",
        "check.category",
        "source_table",
        "source",
      ],
      displayValue: "false",
      limit: INSTANCE_SCAN_LIMIT,
    }));
  } catch (e) {
    rethrowIfCancelled(e);
    return {
      ...unavailable(`${SCAN_FINDING_TABLE} could not be read: ${message(e)}`),
      ...(result ? { result } : {}),
    };
  }

  const findings: ScanFinding[] = [];
  const byPriority: Record<string, number> = {};
  const byArtifactType: Record<string, number> = {};
  for (const r of records) {
    const table = snString(r.source_table);
    const artifactType = table ? artifactTypeForTable(table) : undefined;
    const category = snString(r["check.category"]);
    const f: ScanFinding = {
      check: snString(r["check.name"]) || "(unnamed check)",
      priority: snString(r["check.priority"]) || "unknown",
      ...(category ? { category } : {}),
      table,
      sys_id: snString(r.source),
      ...(artifactType ? { artifactType } : {}),
    };
    findings.push(f);
    byPriority[f.priority] = (byPriority[f.priority] ?? 0) + 1;
    const key = artifactType ?? "(unregistered)";
    byArtifactType[key] = (byArtifactType[key] ?? 0) + 1;
  }
  return {
    available: true,
    ...(result ? { result } : {}),
    findingCount: findings.length,
    capped: records.length >= INSTANCE_SCAN_LIMIT,
    byPriority,
    byArtifactType,
    findings,
    agreed: agreedFindings(findings, linted),
  };
}

/** Markdown for the Instance Scan section of the code-health report. */
export function renderInstanceScan(report: InstanceScanReport): string[] {
  if (!report.available) {
    return [
      `Unavailable: ${report.unavailableReason ?? "Instance Scan could not be read."}`,
      "",
    ];
  }
  const esc = (s: string): string => s.replaceAll("|", "\\|");
  const source = report.result
    ? `Latest scan result \`${report.result.sys_id}\` (${report.result.createdOn}${report.result.state ? `, ${report.result.state}` : ""})`
    : "No scan result found; active findings";
  const counts = (o: Record<string, number>): string =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ") || "none";
  const lines = [
    `${source}: ${report.findingCount} findings${report.capped ? ` (capped at ${INSTANCE_SCAN_LIMIT})` : ""}.`,
    "",
    `- By priority: ${counts(report.byPriority)}`,
    `- By artefact type: ${counts(report.byArtifactType)}`,
    `- Both agree (Instance Scan and our lint flag the record): ${report.agreed.length}`,
    "",
  ];
  if (report.findings.length > 0) {
    lines.push(
      "| Check | Priority | Artefact type | Table | Record |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const f of report.findings.slice(0, RENDER_TOP)) {
      lines.push(
        `| ${esc(f.check)} | ${esc(f.priority)} | ${f.artifactType ?? ""} | ${esc(f.table)} | ${f.sys_id} |`,
      );
    }
    lines.push("");
  }
  if (report.agreed.length > 0) {
    lines.push(
      "| Table | Record | Instance Scan checks |",
      "| --- | --- | --- |",
    );
    for (const a of report.agreed) {
      lines.push(
        `| ${esc(a.table)} | ${a.sys_id} | ${esc(a.checks.join(", "))} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "Read-only: the latest stored result is shown, no scan is run. Our lint runs on a table (`scope`) or with `extended`; without either the agreement set is empty. Table and field names are unverified until O-5 (PDI).",
    "",
  );
  return lines;
}

// ── run (phase D) ─────────────────────────────────────────────────────────

/** What a scan run covers: the whole instance, one record, or one suite. */
export type InstanceScanTarget =
  | { kind: "full" }
  | { kind: "point"; table: string; sysId: string }
  | { kind: "suite"; suiteSysId: string };

const SCAN_PATH = "/api/sn_cicd/instance_scan";

/** The CI/CD path and query of a scan run. */
export function scanRunRequest(target: InstanceScanTarget): {
  path: string;
  params?: URLSearchParams;
} {
  switch (target.kind) {
    case "full":
      return { path: `${SCAN_PATH}/full_scan` };
    case "point":
      assertNoCaret(target.table, "table");
      return {
        path: `${SCAN_PATH}/point_scan`,
        params: new URLSearchParams({
          target_table: target.table,
          target_sys_id: target.sysId,
        }),
      };
    case "suite":
      return {
        path: `${SCAN_PATH}/suite_scan/${encodeURIComponent(target.suiteSysId)}`,
      };
  }
}

/**
 * Start an Instance Scan through the CI/CD API, behind the same rails as an
 * ATF run: a write (the instance executes every check), refused in read-only
 * mode and on a table the policy blocks (`scan_result`, plus the target
 * table of a point scan), and wrapped in {@link pluginCall} so an inactive
 * `sn_cicd` plugin reports clearly. Returns the progress id to poll with
 * {@link waitForInstanceScan}. The refusal on a production-marked profile
 * waits for the H-11 marker (O-4); the endpoints are unverified until O-5.
 */
export async function runInstanceScan(
  target: InstanceScanTarget,
): Promise<AtfRun> {
  assertTableAllowed(SCAN_RESULT_TABLE); // H-4: the backing table
  if (target.kind === "point") assertTableAllowed(target.table);
  assertWriteAllowed(`run instance scan (${target.kind})`);
  const { path, params } = scanRunRequest(target);
  return pluginCall("CI/CD", async () => {
    const { data } = await snRequest<{ result: CicdResult }>({
      method: "POST",
      path,
      ...(params ? { params } : {}),
    });
    return toRun(expectResult(data, "CI/CD instance scan"));
  });
}

/**
 * Poll a started scan through the CI/CD progress API until it finishes or
 * `waitMs` runs out (cancellable, progress reported), as for an ATF run.
 */
export function waitForInstanceScan(
  run: AtfRun,
  waitMs: number,
  pollMs = 2000,
): Promise<AtfRun & { wait: AtfWait }> {
  return waitForAtfRun(run, waitMs, pollMs, "Instance scan in progress");
}
