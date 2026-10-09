import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../core/logging.js";
import { activeProfile, listProfiles } from "../core/config.js";
import {
  getDestructiveConfirm,
  getProfileEnv,
  structuredResults,
} from "../core/settings.js";
import {
  runWithProfile,
  runWithClient,
  runWithTool,
  runWithCall,
  type CallContext,
} from "../core/request-context.js";
import {
  nextCallId,
  publishToolCallEvent,
  resultBytes,
  resultErrorCode,
  traceContextFromMeta,
} from "../core/tracing.js";
import { createProgressSink, type ProgressNotification } from "./progress.js";
import { fail, type ToolResult } from "./result.js";
import { capResult, supportsFileFormat } from "./result-cap.js";
import { planArgsHash } from "./plan-token.js";
import { createSecretRegistry } from "../core/secret-columns.js";
import { confirmDestructiveApply } from "./confirm.js";
import type { JournalInput } from "../core/write-journal.js";
import { EMAIL_ADDRESS_RE } from "../api/shared.js";
import { legacyToolNames, type ToolName } from "./naming.js";

/**
 * The MCP behaviour hints every tool must declare (M-8 / GAP L4-07): all four
 * keys are required, so a tool cannot be registered with an implicit hint the
 * client would otherwise default (MCP defaults `destructiveHint` and
 * `openWorldHint` to true). Read-only tools declare `destructiveHint: false`
 * and `idempotentHint: true`; local-only tools declare `openWorldHint: false`.
 */
export interface ToolAnnotationSet {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * A tool as *data*: one object carries the name, docs, package tag, schema and
 * handler. The registry turns the manifest into MCP registrations, wraps every
 * handler in uniform logging/error handling, and the docs generators read the
 * same objects — a package is plugged in or out by adding/removing its specs
 * from the manifest list, nothing else.
 */
export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  /** M-7: the v3 name, `servicenow_<verb>_<noun>` (see naming.ts TOOLS). */
  name: ToolName;
  title: string;
  description: string;
  /** Package this tool belongs to — the only place the tag lives. */
  package: string;
  annotations: ToolAnnotationSet;
  /** zod input shape; every field carries a .describe(). */
  input: S;
  /**
   * Optional zod output shape (MCP outputSchema, M-6). The registered schema
   * is `z.looseObject(output)` (see buildOutputSchema) so a payload
   * may carry more keys than it declares. A success result without
   * structuredContent gets its JSON text parsed into it by runSpec; an error
   * result never carries structuredContent.
   */
  output?: z.ZodRawShape;
  /**
   * H-3: marks the tool's `apply:true` as destructive. The registry adds a
   * `plan_token` argument; under SN_DESTRUCTIVE_CONFIRM=token|elicit (plan
   * mode only) the plan preview issues a token and an apply without the
   * token of a matching preview is refused (PLAN_REQUIRED); `elicit` also
   * asks the client. With the setting `off` the argument is ignored.
   * `when` narrows it to some calls (a batch that writes); `target` names
   * the record for the confirmation prompt and a refusal's journal line.
   */
  confirm?: ConfirmSpec;
  /**
   * M-7 (B2): v2 parameter names → their v3 name. Accepted only under
   * SN_LEGACY_TOOL_NAMES=1 (one minor cycle); otherwise an unknown argument.
   */
  legacyParams?: Readonly<Record<string, string>>;
  /**
   * M-7: documented deprecated aliases → their canonical name, accepted
   * always (e.g. `class_name` for `table` on the CMDB tools).
   */
  deprecatedParams?: Readonly<Record<string, string>>;
  /** Fields for the log line; never secrets or raw encoded queries. */
  logFields?: (args: z.output<z.ZodObject<S>>) => Record<string, unknown>;
  handler: (args: z.output<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>;
}

/** H-3: see ToolSpec.confirm. */
export interface ConfirmSpec {
  when?: (args: Record<string, unknown>) => boolean;
  target: (
    args: Record<string, unknown>,
  ) => Pick<JournalInput, "action" | "table"> & Partial<JournalInput>;
}

/** Type-erased spec, so manifests of differently-shaped tools can be listed. */
export type AnyToolSpec = ToolSpec<z.ZodRawShape>;

/**
 * A package as one object (A2-1): its tools plus optional package-scoped MCP
 * resources. The registry enables/disables the whole unit declaratively —
 * plugging a package in or out touches exactly one manifest entry.
 */
export interface PackageSpec {
  name: string;
  tools: AnyToolSpec[];
  /** Registered only while the package is enabled (and not denied). */
  resources?: (server: McpServer) => void;
}

/** Identity helper that erases the shape generic while type-checking the spec. */
export function defineTool<S extends z.ZodRawShape>(
  spec: ToolSpec<S>,
): AnyToolSpec {
  return spec as unknown as AnyToolSpec;
}

/**
 * True when the registry should add the automatic `instance` (profile)
 * parameter — skipped for tools whose own schema already uses the name
 * (set_credentials' `instance` means the host).
 */
export function hasAutoInstanceParam(spec: AnyToolSpec): boolean {
  return !("instance" in spec.input);
}

/**
 * The part of the SDK's request-handler `extra` a tool call uses (M-3). The
 * SDK object is passed as is; tests and in-process callers pass a subset.
 */
export interface CallExtra {
  /** MCP session id of an HTTP client (stdio has none). */
  sessionId?: string;
  /** JSON-RPC id of the tools/call request. */
  requestId?: string | number;
  /** Aborted when the client sends notifications/cancelled for the call. */
  signal?: AbortSignal;
  /**
   * The request's `params._meta`: the progress token (M-3) and the W3C Trace
   * Context the client propagates (N-55).
   */
  _meta?: {
    progressToken?: string | number;
    traceparent?: unknown;
    tracestate?: unknown;
  };
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

/**
 * Execute a spec's handler with structured logging and uniform error mapping
 * (the former tools/util.ts runTool, absorbed by the manifest layer). When
 * the model passed the automatic `instance` argument, the whole call runs in
 * that profile's AsyncLocalStorage context (MI-3) — config/auth/http/policy
 * resolve it at call time. `extra.sessionId` (the MCP session of an HTTP
 * client) is carried the same way so the write journal can name the client,
 * and so is the tool name (S-2: the journal records which tool wrote a line).
 *
 * M-3: the call also runs in a call context (request-context.ts) built from
 * the SDK `extra` — `signal` aborts every in-flight request of the call,
 * `_meta.progressToken` enables throttled notifications/progress, and every
 * log line carries `{profile, requestId, sessionId?, tool}`.
 */
export async function runSpec(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  extra: CallExtra = {},
): Promise<ToolResult> {
  const token = extra._meta?.progressToken;
  const progress =
    token !== undefined && extra.sendNotification
      ? createProgressSink(token, extra.sendNotification)
      : undefined;
  const trace = traceContextFromMeta(extra._meta);
  const call: CallContext = {
    requestId:
      extra.requestId === undefined
        ? `local-${randomUUID()}`
        : String(extra.requestId),
    ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    tool: spec.name,
    secrets: createSecretRegistry(),
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(progress ? { progress: progress.sink } : {}),
    callId: nextCallId(),
    ...(trace ? { trace } : {}),
  };
  // N-55: the diagnostics_channel envelope of the call (tracing.ts) — built
  // lazily, so an unobserved call pays only the hasSubscribers checks.
  const started = Date.now();
  publishToolCallEvent("start", () => toolCallMessage(spec, call));
  let result: ToolResult;
  try {
    result = await runWithCall(call, () =>
      runWithClient(extra.sessionId, () =>
        runWithTool(spec.name, () => runSpecInner(spec, args, call)),
      ),
    );
  } catch (error) {
    // runSpecInner maps every failure to a result; this is the safety net.
    publishToolCallEvent("error", () => ({
      ...toolCallMessage(spec, call),
      outcome: call.signal?.aborted ? "cancelled" : "error",
      ms: Date.now() - started,
      errorName: error instanceof Error ? error.name : typeof error,
    }));
    throw error;
  } finally {
    progress?.flush();
  }
  const outcome = result.isError
    ? call.signal?.aborted
      ? "cancelled"
      : "error"
    : "ok";
  publishToolCallEvent(result.isError ? "error" : "end", () => {
    const code = result.isError ? resultErrorCode(result) : undefined;
    return {
      ...toolCallMessage(spec, call),
      outcome,
      ms: Date.now() - started,
      ...(code ? { code } : {}),
      resultBytes: resultBytes(result),
    };
  });
  return result;
}

/**
 * N-55: the metadata every tool-call event carries — never the arguments,
 * the result or a credential. `profile` is the alias the call resolved to
 * (absent on `start`, which runs before the `instance` argument is read).
 */
function toolCallMessage(
  spec: AnyToolSpec,
  call: CallContext,
): Record<string, unknown> {
  return {
    id: call.callId,
    tool: spec.name,
    package: spec.package,
    requestId: call.requestId,
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    ...(call.profile ? { profile: call.profile } : {}),
    ...(call.trace
      ? {
          traceparent: call.trace.traceparent,
          ...(call.trace.tracestate
            ? { tracestate: call.trace.tracestate }
            : {}),
        }
      : {}),
  };
}

async function runSpecInner(
  spec: AnyToolSpec,
  rawArgs: Record<string, unknown>,
  call: CallContext,
): Promise<ToolResult> {
  const normalized = normalizeParamAliases(spec, rawArgs);
  if ("error" in normalized) return normalized.error;
  const args = normalized.args;
  let profile: string | undefined;
  if (hasAutoInstanceParam(spec) && typeof args.instance === "string") {
    profile = args.instance.trim().toLowerCase();
    if (profile && !listProfiles().includes(profile)) {
      return fail(
        `Unknown connection profile "${profile}". Available: ${listProfiles().join(", ") || "(none)"}. See servicenow_list_instances.`,
        {
          code: "UNKNOWN_PROFILE",
          hint: "Pass a profile servicenow_list_instances names, or add one with servicenow_set_credentials.",
        },
      );
    }
  }

  call.profile = profile || activeProfile();
  // H-3: a destructive-apply tool's call knows its plan binding, so its plan
  // preview can issue a plan_token for exactly these arguments.
  if (spec.confirm && getDestructiveConfirm(call.profile) !== "off") {
    call.plan = { argsHash: planArgsHash(args) };
  }
  const fields = spec.logFields?.(args) ?? {};
  const start = Date.now();
  logger.debug(`tool ${spec.name} start`, fields);
  try {
    // H-3: the gate runs in the call's profile context, so a refusal is
    // journaled under the profile the write targeted.
    const invoke = async (): Promise<ToolResult> =>
      (await confirmDestructiveApply(spec, args, call)) ??
      (await spec.handler(args));
    const result = profile
      ? await runWithProfile(profile, invoke)
      : await invoke();
    logger.info(`tool ${spec.name} done`, {
      ...fields,
      ms: Date.now() - start,
      isError: result.isError ?? false,
    });
    // H-11 (L3-03): a result from a profile marked with an environment says so.
    const env = getProfileEnv(call.profile);
    const marked = env
      ? { ...result, _meta: { ...result._meta, environment: env } }
      : result;
    // N-61: one shape-preserving size cap for every tool, before the
    // structuredContent step so tools without an output schema are capped too.
    const capped = capResult(marked, {
      fileHint: supportsFileFormat(spec.input),
    });
    // N-39: SN_STRUCTURED=false — the payload goes out once, as text.
    if (!structuredResults()) return withoutStructuredContent(capped);
    return spec.output ? withStructuredContent(spec, capped) : capped;
  } catch (error) {
    const cancelled = call.signal?.aborted === true;
    logger.warn(`tool ${spec.name} ${cancelled ? "cancelled" : "error"}`, {
      ...fields,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(error);
  }
}

/**
 * M-7: the parameter aliases a spec accepts right now — its deprecated
 * aliases always, its v2 (legacy) names only under SN_LEGACY_TOOL_NAMES=1.
 */
export function activeParamAliases(
  spec: AnyToolSpec,
  legacy: boolean = legacyToolNames(),
): Record<string, string> {
  return {
    ...(legacy ? spec.legacyParams : {}),
    ...spec.deprecatedParams,
  };
}

const warnedAliases = new Set<string>();

/**
 * M-7: move every accepted alias argument to its canonical name before the
 * call runs (so the plan token, the confirmation and the handler only ever
 * see canonical names), then re-check the arguments against the canonical
 * schema — the registered schema had to make an aliased parameter optional.
 * Passing both an alias and its canonical name is INVALID_INPUT.
 */
function normalizeParamAliases(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: ToolResult } {
  const aliases = activeParamAliases(spec);
  const used = Object.keys(aliases).filter((a) => a in args);
  if (!used.length) return { args };
  const out: Record<string, unknown> = { ...args };
  for (const alias of used) {
    const canonical = aliases[alias]!;
    if (canonical in out) {
      return {
        error: fail(
          `Pass either '${canonical}' or its deprecated alias '${alias}', not both.`,
          {
            code: "INVALID_INPUT",
            hint: `Use '${canonical}' only.`,
          },
        ),
      };
    }
    out[canonical] = out[alias];
    delete out[alias];
    const key = `${spec.name}.${alias}`;
    if (!warnedAliases.has(key)) {
      warnedAliases.add(key);
      logger.warn(
        `Parameter '${alias}' of ${spec.name} is deprecated — use '${canonical}'.`,
      );
    }
  }
  const parsed = buildInputSchema(spec, { aliases: false }).safeParse(out);
  if (!parsed.success) {
    return {
      error: fail(
        `Invalid arguments for ${spec.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
        { code: "INVALID_INPUT" },
      ),
    };
  }
  return { args: parsed.data };
}

/** The result without its structuredContent (errors, N-39 SN_STRUCTURED=false). */
function withoutStructuredContent(result: ToolResult): ToolResult {
  if (result.structuredContent === undefined) return result;
  const stripped = { ...result };
  delete stripped.structuredContent;
  return stripped;
}

/**
 * M-6: the structuredContent of a tool that declares an output shape. The
 * text content stays as it is (older clients read only that); a success
 * result whose first text block is a JSON object gets that object as
 * structuredContent (it is already redacted by ok() and size-capped by
 * capResult in runSpecInner). An error
 * result never carries structuredContent — the SDK skips output validation
 * for errors and a client must not mistake an error body for data.
 */
function withStructuredContent(
  spec: AnyToolSpec,
  result: ToolResult,
): ToolResult {
  if (result.isError) return withoutStructuredContent(result);
  if (result.structuredContent !== undefined) return result;
  const text = result.content[0]?.text;
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        ...result,
        structuredContent: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // not JSON — reported below
  }
  logger.warn(
    `tool ${spec.name} declares an output schema but its result is not a JSON object`,
  );
  return result;
}

// --- typed input builders ------------------------------------------------------
// M-8 (GAP L2-06 / L2-07): every string and array a tool accepts goes through
// one of these, so no parameter is unbounded and names that end up in a URL
// path or an encoded query are character-checked before any request. The
// bounds are deliberately generous — they stop a runaway (multi-megabyte)
// argument or a path/query injection, not any call that works today. The
// intentionally unbounded parameters (content capped at run time by an SN_*
// setting) are listed in test/schema-bounds.test.js.

/**
 * A record sys_id. ServiceNow generates 32 lowercase hex characters, but
 * system records exist with readable ids (`global` in sys_scope, and imports
 * may carry any id up to the column's 32 characters) — so the check is the
 * GUID column's shape (letters, digits, `_`, `-`; at most 32), which still
 * rejects the `/`, `?`, `^` and whitespace that would change the URL or query.
 */
export const SYS_ID_SHAPE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** A table name: letters, digits and `_` (sys_db_object.name, at most 80). */
export const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,80}$/;

/**
 * A field name, optionally dot-walked (`caller_id.name`). A comma-separated
 * list inside one entry (`"number,short_description"`) is tolerated because
 * the Table API receives the list joined with commas anyway.
 */
export const FIELD_NAME_RE = /^[A-Za-z0-9_.]+(?:\s*,\s*[A-Za-z0-9_.]+)*$/;

/** Default maximum length of an encoded query (sysparm_query). */
export const ENCODED_QUERY_MAX = 8000;

/** Default maximum length of a long free text (an email body, a description). */
export const LONG_TEXT_MAX = 1_048_576;

/** A sys_id (see SYS_ID_SHAPE_RE). */
export function sysId() {
  return z
    .string()
    .max(32)
    .regex(
      SYS_ID_SHAPE_RE,
      "must be a sys_id (letters, digits, '_' or '-'; ≤ 32)",
    );
}

/** A table name (see TABLE_NAME_RE). */
export function tableName() {
  return z
    .string()
    .max(80)
    .regex(TABLE_NAME_RE, "must be a table name (letters, digits, '_'; ≤ 80)");
}

/** A field name, possibly dot-walked (see FIELD_NAME_RE). */
export function fieldName() {
  return z
    .string()
    .max(255)
    .regex(FIELD_NAME_RE, "must be a field name, e.g. 'short_description'");
}

/** An encoded query (sysparm_query), bounded by length only. */
export function encodedQuery(max = ENCODED_QUERY_MAX) {
  return z.string().max(max);
}

/** A list of field names (at most `max`). */
export function fieldList(max = 200) {
  return z.array(fieldName()).max(max);
}

/** A short free text: a name, a label, a search term, an identifier. */
export function shortText(max = 255) {
  return z.string().max(max);
}

/** A long free text (email body, record description). */
export function longText(max = LONG_TEXT_MAX) {
  return z.string().max(max);
}

/** A list of table names (at most `max`). */
export function tableList(max = 200) {
  return z.array(tableName()).max(max);
}

/** A list of sys_ids (at most `max`). */
export function sysIdList(max = 500) {
  return z.array(sysId()).max(max);
}

/** One email address (see EMAIL_ADDRESS_RE — no display names, no separators). */
export function email() {
  return z
    .string()
    .max(254)
    .regex(EMAIL_ADDRESS_RE, "must be a single email address (name@domain)");
}

/** A bounded list of email addresses (at least one, at most `max`). */
export function recipients(max = 50) {
  return z.array(email()).min(1).max(max);
}

/** The automatic `instance` (connection profile) parameter (MI-3). */
export const instanceParam = shortText(128)
  .optional()
  .describe("Profile (default active)");

/**
 * H-3: the automatic `plan_token` parameter of a destructive-apply tool. Its
 * description stays short — tools/list is budgeted (M-6).
 */
export const planTokenParam = shortText(64)
  .optional()
  .describe("Plan preview token (apply:true)");

/**
 * The registered input schema of a spec: its own shape plus the automatic
 * `instance` parameter (unless the spec already uses the name), as a strict
 * object — an unknown argument (e.g. a typo like 'tabel') is a visible
 * validation error instead of being stripped silently.
 *
 * M-7: with `aliases` (the default) each accepted alias (activeParamAliases)
 * is added as an optional parameter with the canonical one's schema, and the
 * canonical parameter becomes optional too (runSpec re-checks the arguments
 * against the alias-free schema once the alias is moved). `legacy` defaults
 * to SN_LEGACY_TOOL_NAMES.
 */
export function buildInputSchema(
  spec: AnyToolSpec,
  options: { aliases?: boolean; legacy?: boolean } = {},
) {
  const shape: Record<string, z.core.$ZodType> = hasAutoInstanceParam(spec)
    ? { ...spec.input, instance: instanceParam }
    : { ...spec.input };
  if (spec.confirm && !("plan_token" in shape))
    shape.plan_token = planTokenParam;
  if (options.aliases !== false) {
    const aliases = activeParamAliases(spec, options.legacy);
    for (const [alias, canonical] of Object.entries(aliases)) {
      const target = shape[canonical] as z.ZodType | undefined;
      if (!target || alias in shape) continue;
      const optional = target.optional();
      shape[canonical] = optional;
      shape[alias] = target.optional().describe(`Deprecated: use ${canonical}`);
    }
  }
  return z.object(shape).strict();
}

/**
 * The registered output schema of a spec (M-6): its output shape as a
 * loose object — permissive by design, so a payload may add keys without a
 * schema change (JSON Schema `additionalProperties: {}`, i.e. any value).
 */
export function buildOutputSchema(spec: AnyToolSpec) {
  return spec.output ? z.looseObject(spec.output) : undefined;
}
