import { createHash } from "node:crypto";
import { ServiceNowError } from "../core/errors.js";
import { snRequest } from "../core/http.js";
import { assertWriteAllowed, assertTableAllowed } from "../core/policy.js";
import { expectResult, expectResultArray, snString } from "./shared.js";
import { pluginCall } from "./plugin.js";
import { toRun, type AtfRun, type CicdResult } from "./atf.js";

/**
 * N-4 (O-11, option B): the update set lane of the CI/CD API, package
 * `cicd`. A retrieved update set (`sys_remote_update_set`) is previewed and
 * committed through `/api/sn_cicd/update_set/{preview|commit}/{sys_id}`;
 * both start an instance job whose progress id polls like an ATF run. A
 * commit runs only after a clean preview — the remote set is `previewed` and
 * none of its preview problems is unresolved — and never with
 * `force_commit`. App install / publish and plugin activation wait for a
 * later gate. Table and field names follow the platform docs and are
 * unverified on a PDI until O-5.
 */

const LABEL = "CI/CD";

export const REMOTE_UPDATE_SET_TABLE = "sys_remote_update_set";
export const PREVIEW_PROBLEM_TABLE = "sys_update_preview_problem";

/** Most preview problems listed in a result; the counts cover them all. */
export const PROBLEM_LIST_MAX = 50;

/** Problem rows read to count them (a preview past this is not clean). */
const PROBLEM_READ_MAX = 1000;

export interface PreviewProblem {
  sys_id: string;
  type: string;
  status: string;
  description: string;
}

/** The preview state of one retrieved update set. */
export interface PreviewState {
  sys_id: string;
  name: string;
  state: string;
  problems: {
    total: number;
    unresolved: number;
    truncated: boolean;
    items: PreviewProblem[];
  };
  /** `previewed` with no unresolved problem: the only state a commit accepts. */
  clean: boolean;
  /** sha256 over the set's state and its problems, bound into a commit plan. */
  fingerprint: string;
}

/**
 * A problem counts as resolved once someone accepted or skipped the remote
 * update in the preview (`status` set); an empty status is unresolved.
 */
function unresolved(problem: PreviewProblem): boolean {
  return problem.status === "";
}

/**
 * Read a retrieved update set and its preview problems. 404 → NOT_FOUND;
 * more than {@link PROBLEM_READ_MAX} problems mark the result `truncated`
 * and never clean.
 */
export async function readPreviewState(sysId: string): Promise<PreviewState> {
  assertTableAllowed(REMOTE_UPDATE_SET_TABLE); // H-4: the backing tables
  assertTableAllowed(PREVIEW_PROBLEM_TABLE);
  const { data: setData } = await snRequest<{
    result: Record<string, unknown>;
  }>({
    method: "GET",
    path: `/api/now/table/${REMOTE_UPDATE_SET_TABLE}/${encodeURIComponent(sysId)}`,
    params: new URLSearchParams({
      sysparm_fields: "sys_id,name,state,sys_mod_count,sys_updated_on",
      sysparm_display_value: "false",
    }),
  });
  const set = expectResult(setData, "Table");
  const { data: problemData } = await snRequest<{
    result: Record<string, unknown>[];
  }>({
    method: "GET",
    path: `/api/now/table/${PREVIEW_PROBLEM_TABLE}`,
    params: new URLSearchParams({
      sysparm_query: `remote_update_set=${sysId}^ORDERBYsys_created_on`,
      sysparm_fields: "sys_id,type,status,description",
      sysparm_limit: String(PROBLEM_READ_MAX + 1),
      sysparm_display_value: "false",
    }),
  });
  const rows = expectResultArray(problemData, "Table");
  const truncated = rows.length > PROBLEM_READ_MAX;
  const problems = rows.slice(0, PROBLEM_READ_MAX).map((row) => ({
    sys_id: snString(row.sys_id),
    type: snString(row.type),
    status: snString(row.status),
    description: snString(row.description),
  }));
  const open = problems.filter(unresolved);
  const state = snString(set.state);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        snString(set.sys_id) || sysId,
        state,
        snString(set.sys_mod_count),
        snString(set.sys_updated_on),
        truncated,
        problems.map((p) => `${p.sys_id}:${p.status}`).sort(),
      ]),
    )
    .digest("hex");
  return {
    sys_id: snString(set.sys_id) || sysId,
    name: snString(set.name),
    state,
    problems: {
      total: problems.length,
      unresolved: open.length,
      truncated,
      // Unresolved first: they are the ones that block the commit.
      items: [...open, ...problems.filter((p) => !unresolved(p))].slice(
        0,
        PROBLEM_LIST_MAX,
      ),
    },
    clean: state === "previewed" && open.length === 0 && !truncated,
    fingerprint,
  };
}

/**
 * Refuse a commit unless the preview is clean, and — when the commit was
 * planned — unless the preview is still the one the plan showed.
 */
export function assertCommitAllowed(
  preview: PreviewState,
  planned?: string,
): void {
  if (!preview.clean) {
    const why =
      preview.state !== "previewed"
        ? `its state is "${preview.state || "unknown"}", not "previewed"`
        : preview.problems.truncated
          ? `its preview has more than ${PROBLEM_READ_MAX} problems`
          : `its preview has ${preview.problems.unresolved} unresolved problem(s)`;
    throw new ServiceNowError(
      `Update set "${preview.name || preview.sys_id}" cannot be committed: ${why}. Nothing was committed.`,
      409,
      undefined,
      {
        code: "CONFLICT",
        hint: "Run step 'preview', resolve every problem on the instance (accept or skip the remote update), then plan the commit again. force_commit is never used.",
      },
    );
  }
  if (planned !== undefined && planned !== preview.fingerprint) {
    throw new ServiceNowError(
      `Update set "${preview.name || preview.sys_id}" changed after the commit was planned. Nothing was committed.`,
      409,
      undefined,
      {
        code: "STALE_RECORD",
        hint: "Plan the commit again (without apply) and review the new preview.",
      },
    );
  }
}

/**
 * Start a preview or a commit through the CI/CD API. A write (the instance
 * runs a job), refused in read-only mode and on a blocked table; an inactive
 * `sn_cicd` plugin reports through {@link pluginCall}. A commit always sends
 * `force_commit=false`, so an instance default can never force it.
 */
export async function startUpdateSetJob(
  step: "preview" | "commit",
  sysId: string,
): Promise<AtfRun> {
  assertTableAllowed(REMOTE_UPDATE_SET_TABLE);
  assertWriteAllowed(`${step} update set`);
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: CicdResult }>({
      method: "POST",
      path: `/api/sn_cicd/update_set/${step}/${encodeURIComponent(sysId)}`,
      ...(step === "commit"
        ? { params: new URLSearchParams({ force_commit: "false" }) }
        : {}),
    });
    return toRun(expectResult(data, `CI/CD update set ${step}`));
  });
}
