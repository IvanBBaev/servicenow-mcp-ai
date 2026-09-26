import { snRequest } from "../core/http.js";
import { delay } from "../core/http-util.js";
import { reportProgress, throwIfCancelled } from "../core/progress.js";
import { currentSignal } from "../core/request-context.js";
import { assertWriteAllowed, assertTableAllowed } from "../core/policy.js";
import { expectResult, expectResultArray, snString } from "./shared.js";
import { pluginCall } from "./plugin.js";
import type { SnRecord } from "./table.js";

/**
 * Automated Test Framework (ATF) execution (Phase 8, package `atf`). Listing is
 * a plain Table API read; running tests goes through the CI/CD API
 * (`/api/sn_cicd/...`, the `sn_cicd` plugin) and **executes code on the
 * instance** — so the run tools are not read-only and the package never enters
 * the default profile. Exact CI/CD paths can vary by instance version; calls are
 * wrapped in {@link pluginCall} so an inactive plugin reports clearly.
 */

const LABEL = "CI/CD";

export interface AtfQuery {
  query?: string;
  active?: boolean;
  limit?: number;
}

export interface AtfTestSummary extends SnRecord {
  sys_id?: string;
  name?: string;
  active?: string;
}

/** List ATF tests (`sys_atf_test`). */
export async function listAtfTests(
  opts: AtfQuery = {},
): Promise<AtfTestSummary[]> {
  assertTableAllowed("sys_atf_test"); // H-4: the backing table
  const clauses: string[] = [];
  if (opts.active !== undefined) clauses.push(`active=${opts.active}`);
  if (opts.query?.trim()) clauses.push(opts.query.trim());
  clauses.push("ORDERBYname");
  const params = new URLSearchParams({
    sysparm_query: clauses.join("^"),
    sysparm_fields: "sys_id,name,active,description",
    sysparm_limit: String(opts.limit ?? 50),
    sysparm_display_value: "false",
  });
  const { data } = await snRequest<{ result: AtfTestSummary[] }>({
    method: "GET",
    path: "/api/now/table/sys_atf_test",
    params,
  });
  return expectResultArray(data, "ATF");
}

/** List ATF test suites (`sys_atf_test_suite`). */
export async function listAtfSuites(
  opts: AtfQuery = {},
): Promise<AtfTestSummary[]> {
  assertTableAllowed("sys_atf_test_suite"); // H-4: the backing table
  const clauses: string[] = [];
  if (opts.active !== undefined) clauses.push(`active=${opts.active}`);
  if (opts.query?.trim()) clauses.push(opts.query.trim());
  clauses.push("ORDERBYname");
  const params = new URLSearchParams({
    sysparm_query: clauses.join("^"),
    sysparm_fields: "sys_id,name,active,description",
    sysparm_limit: String(opts.limit ?? 50),
    sysparm_display_value: "false",
  });
  const { data } = await snRequest<{ result: AtfTestSummary[] }>({
    method: "GET",
    path: "/api/now/table/sys_atf_test_suite",
    params,
  });
  return expectResultArray(data, "ATF");
}

export interface AtfRun {
  executionId?: string;
  status?: string;
  statusLabel?: string;
  statusMessage?: string;
  percentComplete?: number;
  progressUrl?: string;
}

interface CicdResult {
  status?: string;
  status_label?: string;
  status_message?: string;
  percent_complete?: number | string;
  links?: { progress?: { id?: string; url?: string } };
}

function toRun(result: CicdResult): AtfRun {
  const pct = Number(snString(result.percent_complete));
  return {
    executionId: result.links?.progress?.id,
    status: snString(result.status) || undefined,
    statusLabel: snString(result.status_label) || undefined,
    statusMessage: snString(result.status_message) || undefined,
    percentComplete: Number.isFinite(pct) ? pct : undefined,
    progressUrl: result.links?.progress?.url,
  };
}

/**
 * Run an ATF test suite via the CI/CD API. Returns the execution/progress id to
 * poll with {@link getAtfResult}. A write (executes on the instance).
 */
export async function runAtfSuite(suiteSysId: string): Promise<AtfRun> {
  assertTableAllowed("sys_atf_test_suite"); // H-4: the backing table
  assertWriteAllowed("run ATF suite");
  return pluginCall(LABEL, async () => {
    const params = new URLSearchParams({ sys_id: suiteSysId });
    const { data } = await snRequest<{ result: CicdResult }>({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params,
    });
    return toRun(expectResult(data, "CI/CD ATF"));
  });
}

/**
 * Run a single ATF test via the CI/CD API. Note: ServiceNow's CI/CD surface is
 * suite-oriented; on instances without a single-test endpoint, run the suite
 * that contains the test instead. A write (executes on the instance).
 */
export async function runAtfTest(testSysId: string): Promise<AtfRun> {
  assertTableAllowed("sys_atf_test"); // H-4: the backing table
  assertWriteAllowed("run ATF test");
  return pluginCall(LABEL, async () => {
    const params = new URLSearchParams({ test_sys_id: testSysId });
    const { data } = await snRequest<{ result: CicdResult }>({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params,
    });
    return toRun(expectResult(data, "CI/CD ATF"));
  });
}

/** Poll an ATF execution's progress/result by its execution (progress) id. */
export async function getAtfResult(executionId: string): Promise<AtfRun> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: CicdResult }>({
      method: "GET",
      path: `/api/sn_cicd/progress/${encodeURIComponent(executionId)}`,
    });
    return toRun(expectResult(data, "CI/CD ATF"));
  });
}

/** CI/CD progress states that end a run: 2 Successful, 3 Failed, 4 Canceled. */
const FINAL_STATUSES = new Set(["2", "3", "4"]);

export interface AtfWait {
  /** `finished` — the run reached a final state; `running` — the wait ran out. */
  state: "finished" | "running";
  /** The execution id to poll with servicenow_get_atf_result (when still running). */
  tracker?: string;
  polls: number;
  waited_ms: number;
}

/**
 * S-10 — poll a started ATF run until it finishes or `waitMs` runs out, under
 * the tool call's cancellation signal (M-3) and reporting the run's percent
 * complete as progress. Returns the latest run state plus `wait`; on timeout
 * `wait.state` is `running` and `wait.tracker` is the execution id to keep
 * polling with {@link getAtfResult}. A run without an execution id, or one
 * already final, is returned as is.
 */
export async function waitForAtfRun(
  run: AtfRun,
  waitMs: number,
  pollMs = 2000,
): Promise<AtfRun & { wait: AtfWait }> {
  const started = Date.now();
  const id = run.executionId;
  let latest = run;
  let polls = 0;
  const done = (state: AtfWait["state"]) => ({
    ...latest,
    wait: {
      state,
      ...(state === "running" && id ? { tracker: id } : {}),
      polls,
      waited_ms: Date.now() - started,
    },
  });
  if (!id || FINAL_STATUSES.has(latest.status ?? "")) {
    return done(
      FINAL_STATUSES.has(latest.status ?? "") ? "finished" : "running",
    );
  }
  const deadline = started + waitMs;
  const signal = currentSignal();
  for (;;) {
    throwIfCancelled();
    latest = await getAtfResult(id);
    polls++;
    reportProgress({
      progress: latest.percentComplete ?? 0,
      total: 100,
      message:
        latest.statusLabel ?? latest.statusMessage ?? "ATF run in progress",
    });
    if (FINAL_STATUSES.has(latest.status ?? "")) return done("finished");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return done("running");
    await delay(Math.min(pollMs, remaining), signal);
  }
}
