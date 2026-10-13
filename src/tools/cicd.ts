import { z } from "zod";
import { waitForAtfRun, type AtfRun } from "../api/atf.js";
import {
  assertCommitAllowed,
  readPreviewState,
  startUpdateSetJob,
  REMOTE_UPDATE_SET_TABLE,
} from "../api/cicd.js";
import { assertWriteAllowed } from "../core/policy.js";
import { currentCall } from "../core/request-context.js";
import { journaledWrite } from "../core/write-journal.js";
import { ok } from "../mcp/result.js";
import { defineTool, sysId, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";

/** Optional wait for the preview / commit job (default 0 = no wait). */
const waitSeconds = z
  .number()
  .int()
  .nonnegative()
  .max(300)
  .optional()
  .describe(
    "Seconds to wait for the job, polling (default 0). On timeout wait.tracker is the progress id.",
  );

/** Wait on the started job when asked; a finished preview adds its problems. */
async function afterStart(
  run: AtfRun,
  seconds: number | undefined,
  step: "preview" | "commit",
  updateSet: string,
) {
  if (!seconds) return run;
  const waited = await waitForAtfRun(
    run,
    seconds * 1000,
    2000,
    `Update set ${step} in progress`,
  );
  if (step === "commit" || waited.wait.state !== "finished") return waited;
  const preview = await readPreviewState(updateSet);
  return { ...waited, preview, clean: preview.clean };
}

/**
 * CI/CD package (N-4, O-11 option B, ADR 0011): preview and commit a
 * retrieved update set through the CI/CD API. Off by default — enable it
 * explicitly (SN_TOOL_PACKAGES=…,cicd). A commit is destructive: it needs
 * the plan's single-use plan_token under SN_DESTRUCTIVE_CONFIRM, refuses a
 * preview that is not clean, binds the clean preview into the token (a
 * preview that changed after the plan is refused) and never forces. The
 * journal records each run as a non-revertable `execute`.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_commit_update_set",
    title: "Preview or commit a retrieved update set",
    description:
      "Preview (step:'preview') or commit (step:'commit') a retrieved update set (sys_remote_update_set) via the CI/CD API. A commit needs a clean preview — state previewed, no unresolved problem — and is never forced; its plan lists the preview problems.",
    package: "cicd",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    confirm: {
      when: (args) => args.step === "commit",
      target: (args) => ({
        action: "execute",
        table: REMOTE_UPDATE_SET_TABLE,
        sys_id: String(args.update_set),
      }),
    },
    input: {
      update_set: sysId().describe("sys_remote_update_set sys_id."),
      step: z.enum(["preview", "commit"]),
      wait_seconds: waitSeconds,
      apply: applyInput,
    },
    output: {
      mode: z.string().optional(),
      executionId: z.string().optional(),
      status: z.string().optional(),
      clean: z.boolean().optional(),
    },
    logFields: (args) => ({ step: args.step, update_set: args.update_set }),
    handler: async ({ update_set, step, wait_seconds, apply }) => {
      const target = {
        action: "execute" as const,
        table: REMOTE_UPDATE_SET_TABLE,
        sys_id: update_set,
      };
      if (step === "preview") {
        if (!shouldApply(apply)) {
          return planPreview({
            ...target,
            after: { run: "Update set preview" },
          });
        }
        const run = await journaledWrite(target, () =>
          startUpdateSetJob("preview", update_set),
        );
        return ok(await afterStart(run, wait_seconds, step, update_set));
      }
      if (!shouldApply(apply)) {
        // A preview that is not clean gets no plan (and no plan_token).
        const preview = await readPreviewState(update_set);
        assertCommitAllowed(preview);
        return planPreview(
          {
            ...target,
            before: { state: preview.state, problems: preview.problems },
            after: { state: "committed", force_commit: false },
          },
          { clean: true, preview_fingerprint: preview.fingerprint },
          preview.fingerprint,
        );
      }
      // The apply re-reads the preview: still clean, and — when planned under
      // SN_DESTRUCTIVE_CONFIRM — still the preview the token was issued for.
      // Read-only mode refuses first, before the preview is read.
      assertWriteAllowed("commit update set");
      const preview = await readPreviewState(update_set);
      assertCommitAllowed(preview, currentCall()?.plan?.binding);
      const run = await journaledWrite(target, () =>
        startUpdateSetJob("commit", update_set),
      );
      return ok(await afterStart(run, wait_seconds, step, update_set));
    },
  }),
];
