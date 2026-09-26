import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../core/logging.js";
import { activeProfile, listProfiles } from "../core/config.js";
import {
  runWithProfile,
  runWithClient,
  runWithTool,
  runWithCall,
  type CallContext,
} from "../core/request-context.js";
import { createProgressSink, type ProgressNotification } from "./progress.js";
import { fail, type ToolResult } from "./result.js";
import { EMAIL_ADDRESS_RE } from "../api/shared.js";

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
  name: string;
  title: string;
  description: string;
  /** Package this tool belongs to — the only place the tag lives. */
  package: string;
  annotations: ToolAnnotationSet;
  /** zod input shape; every field carries a .describe(). */
  input: S;
  /**
   * Optional zod output shape (MCP outputSchema, M-6). The registered schema
   * is `z.object(output).passthrough()` (see buildOutputSchema) so a payload
   * may carry more keys than it declares. A success result without
   * structuredContent gets its JSON text parsed into it by runSpec; an error
   * result never carries structuredContent.
   */
  output?: z.ZodRawShape;
  /** Fields for the log line; never secrets or raw encoded queries. */
  logFields?: (
    args: z.objectOutputType<S, z.ZodTypeAny>,
  ) => Record<string, unknown>;
  handler: (
    args: z.objectOutputType<S, z.ZodTypeAny>,
  ) => ToolResult | Promise<ToolResult>;
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
  _meta?: { progressToken?: string | number };
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
  const call: CallContext = {
    requestId:
      extra.requestId === undefined
        ? `local-${randomUUID()}`
        : String(extra.requestId),
    ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    tool: spec.name,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(progress ? { progress: progress.sink } : {}),
  };
  try {
    return await runWithCall(call, () =>
      runWithClient(extra.sessionId, () =>
        runWithTool(spec.name, () => runSpecInner(spec, args, call)),
      ),
    );
  } finally {
    progress?.flush();
  }
}

async function runSpecInner(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  call: CallContext,
): Promise<ToolResult> {
  let profile: string | undefined;
  if (hasAutoInstanceParam(spec) && typeof args.instance === "string") {
    profile = args.instance.trim().toLowerCase();
    if (profile && !listProfiles().includes(profile)) {
      return fail(
        `Unknown connection profile "${profile}". Available: ${listProfiles().join(", ") || "(none)"}. See servicenow_list_instances.`,
      );
    }
  }

  call.profile = profile || activeProfile();
  const fields = spec.logFields?.(args) ?? {};
  const start = Date.now();
  logger.debug(`tool ${spec.name} start`, fields);
  try {
    const result = profile
      ? await runWithProfile(profile, () => spec.handler(args))
      : await spec.handler(args);
    logger.info(`tool ${spec.name} done`, {
      ...fields,
      ms: Date.now() - start,
      isError: result.isError ?? false,
    });
    return spec.output ? withStructuredContent(spec, result) : result;
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
 * M-6: the structuredContent of a tool that declares an output shape. The
 * text content stays as it is (older clients read only that); a success
 * result whose first text block is a JSON object gets that object as
 * structuredContent (it is already redacted and truncated by ok()). An error
 * result never carries structuredContent — the SDK skips output validation
 * for errors and a client must not mistake an error body for data.
 */
function withStructuredContent(
  spec: AnyToolSpec,
  result: ToolResult,
): ToolResult {
  if (result.isError) {
    if (result.structuredContent === undefined) return result;
    const stripped = { ...result };
    delete stripped.structuredContent;
    return stripped;
  }
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
export const SYS_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

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

/** A sys_id (see SYS_ID_RE). */
export function sysId() {
  return z
    .string()
    .max(32)
    .regex(SYS_ID_RE, "must be a sys_id (letters, digits, '_' or '-'; ≤ 32)");
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
  .describe("Profile name (default: active)");

/**
 * The registered input schema of a spec: its own shape plus the automatic
 * `instance` parameter (unless the spec already uses the name), as a strict
 * object — an unknown argument (e.g. a typo like 'tabel') is a visible
 * validation error instead of being stripped silently.
 */
export function buildInputSchema(spec: AnyToolSpec) {
  const shape: z.ZodRawShape = hasAutoInstanceParam(spec)
    ? { ...spec.input, instance: instanceParam }
    : spec.input;
  return z.object(shape).strict();
}

/**
 * The registered output schema of a spec (M-6): its output shape as a
 * passthrough object — permissive by design, so a payload may add keys
 * without a schema change (JSON Schema `additionalProperties: true`).
 */
export function buildOutputSchema(spec: AnyToolSpec) {
  return spec.output ? z.object(spec.output).passthrough() : undefined;
}
