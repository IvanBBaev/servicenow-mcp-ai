import { z } from "zod";
import {
  runBatch,
  packageForUrl,
  tablesForSubRequest,
  type BatchResult,
  type BatchSubRequest,
} from "../api/batch.js";
import { ok } from "../mcp/result.js";
import { defineTool, shortText, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { sdkGuard } from "../mcp/sdk-guard.js";
import {
  appendWriteJournal,
  journaledWrite,
  sha256Hex,
  ulid,
  type WriteAction,
} from "../core/write-journal.js";

const subRequestSchema = z.object({
  id: shortText().optional().describe("Id echoed in the matching result."),
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .describe("HTTP method."),
  url: shortText(16_384).describe(
    "API path under the instance origin, e.g. '/api/now/table/incident?sysparm_limit=1'.",
  ),
  body: z.unknown().optional().describe("JSON body for write methods."),
  headers: z
    .array(z.object({ name: shortText(), value: shortText(8192) }))
    .max(50)
    .optional()
    .describe("Extra headers (Accept and Content-Type are automatic)."),
});

const METHOD_ACTION: Record<BatchSubRequest["method"], WriteAction> = {
  GET: "execute", // never journalled: reads are skipped
  POST: "create",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

/**
 * Table and record a sub-request path targets, for its journal line:
 * `/api/now/[v1/]table/<table>[/<sys_id>][/][?query]`. Other REST surfaces
 * journal the path itself as the target.
 */
function batchTarget(url: string): { table: string; sys_id?: string } {
  return tableApiTarget(url) ?? { table: url.split(/[?#]/)[0] ?? url };
}

/** The Table API target of a sub-request path; null for other surfaces. */
function tableApiTarget(
  url: string,
): { table: string; sys_id?: string } | null {
  const m =
    /^\/api\/now\/(?:v\d+\/)?table\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(
      url,
    );
  if (!m) return null;
  const table = decodeURIComponent(m[1] ?? "");
  return m[2] ? { table, sys_id: decodeURIComponent(m[2]) } : { table };
}

/**
 * P-22: the SDK-managed guard for every write sub-request that targets the
 * Table API, keyed by the sub-request's position (1-based, like its default
 * id). In `deny` mode an apply throws SDK_MANAGED_SCOPE before the batch is
 * sent, so no sub-request runs. Empty when nothing is SDK-managed.
 */
async function guardSubRequests(
  requests: BatchSubRequest[],
  phase: "plan" | "apply",
): Promise<Map<number, Record<string, unknown>>> {
  const found = new Map<number, Record<string, unknown>>();
  for (const [index, req] of requests.entries()) {
    if (req.method === "GET") continue;
    const target = tableApiTarget(req.url);
    if (!target) continue;
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : undefined;
    const guard = await sdkGuard(
      {
        ...target,
        ...(body && req.method !== "DELETE" ? { fields: body } : {}),
      },
      phase,
    );
    if (guard) found.set(index, guard);
  }
  return found;
}

/** The sys_id a created record came back with, if the body is a Table API reply. */
function createdSysId(body: unknown): string | undefined {
  const result =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).result
      : undefined;
  const id =
    result && typeof result === "object"
      ? (result as Record<string, unknown>).sys_id
      : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * L2-03 — one journal line per write sub-request, linked to the envelope line
 * by `batch_id`, so a batch is as auditable (and revertible) as the same
 * writes made one by one. The outcome is the sub-request's own status code.
 */
function journalSubRequests(
  batchId: string,
  requests: BatchSubRequest[],
  results: BatchResult[],
): void {
  requests.forEach((req, index) => {
    if (req.method === "GET") return;
    const res = results.find((r) => r.id === (req.id ?? String(index + 1)));
    const target = batchTarget(req.url);
    const applied =
      res !== undefined && res.statusCode >= 200 && res.statusCode < 300;
    const sysId =
      target.sys_id ??
      (applied && req.method === "POST" ? createdSysId(res.body) : undefined);
    appendWriteJournal({
      action: METHOD_ACTION[req.method],
      table: target.table,
      ...(sysId ? { sys_id: sysId } : {}),
      ...(req.body !== undefined && typeof req.body === "object"
        ? { fields: req.body as Record<string, unknown> }
        : {}),
      batch_id: batchId,
      method: req.method,
      ...(req.body !== undefined
        ? { body_sha256: sha256Hex(JSON.stringify(req.body)) }
        : {}),
      result: applied
        ? "applied"
        : res?.statusCode === 403
          ? "refused"
          : "failed",
      ...(applied
        ? {}
        : {
            error:
              res?.error ??
              (res ? `HTTP ${res.statusCode}` : "No result returned."),
          }),
    });
  });
}

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_batch",
    title: "Run a ServiceNow batch",
    description:
      "Run several REST sub-requests in one round-trip (Batch API). Each sub-request runs through the same read-only and table-access policy as a direct call.",
    package: "batch",
    annotations: {
      // A batch may contain writes, so it is not flagged read-only.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    // H-3: only a batch that writes needs a plan (a GET-only batch has none).
    confirm: {
      when: (args) =>
        Array.isArray(args.requests) &&
        args.requests.some((r: { method?: unknown }) => r.method !== "GET"),
      target: () => ({ action: "execute", table: "batch" }),
    },
    input: {
      requests: z
        .array(subRequestSchema)
        .min(1)
        .max(1000)
        .describe("Sub-requests to run."),
      apply: applyInput,
    },
    logFields: (args) => ({ count: args.requests.length }),
    handler: async ({ requests, apply }) => {
      // A read-only batch (all GET) needs no plan gate; a batch that writes does.
      const hasWrites = requests.some((r) => r.method !== "GET");
      if (hasWrites && !shouldApply(apply)) {
        const guards = await guardSubRequests(requests, "plan");
        const refused = [...guards.values()].some(
          (g) =>
            (g.sdkManaged as Record<string, unknown> | undefined)
              ?.would_refuse === true,
        );
        return planPreview(
          {
            action: "execute",
            table: "batch",
            // H-4: the preview shows what each sub-request would send (bodies
            // pass the result redaction like any output) and what it targets.
            after: {
              requests: requests.map((r, index) => {
                const tables = tablesForSubRequest(r);
                const pkg = packageForUrl(r.url);
                return {
                  method: r.method,
                  url: r.url,
                  ...(r.body !== undefined ? { body: r.body } : {}),
                  ...(tables.length ? { tables } : {}),
                  package: pkg ?? null,
                  ...guards.get(index),
                };
              }),
            },
          },
          refused ? { would_refuse: true } : {},
        );
      }
      if (!hasWrites) {
        const results = await runBatch(requests);
        return ok({ count: results.length, results });
      }
      // P-22: judged before the batch is sent — a deny stops every sub-request.
      const guards = await guardSubRequests(requests, "apply");
      const sdk = guards.size
        ? {
            sdkManaged: [...guards].map(([index, g]) => ({
              request: requests[index]?.id ?? String(index + 1),
              ...(g.sdkManaged as Record<string, unknown> | undefined),
              ...(g.sdkScopeWarning
                ? { sdkScopeWarning: g.sdkScopeWarning }
                : {}),
            })),
          }
        : {};
      const batchId = ulid();
      const results = await journaledWrite(
        {
          action: "execute",
          table: "batch",
          fields: { sub_requests: requests.length },
          batch_id: batchId,
        },
        () => runBatch(requests),
        undefined,
        // H-11: the session caps count the write sub-requests, not the envelope.
        {
          writes: requests.filter((r) => r.method !== "GET").length,
          deletes: requests.filter((r) => r.method === "DELETE").length,
        },
      );
      journalSubRequests(batchId, requests, results);
      return ok({ count: results.length, results, ...sdk });
    },
  }),
];
