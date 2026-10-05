import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { snString } from "../api/shared.js";
import { getRecord } from "../api/table.js";
import { listProfiles } from "../core/config.js";
import { ServiceNowError, errorCodeOf } from "../core/errors.js";
import { logger } from "../core/logging.js";
import {
  currentSession,
  runInSession,
  runWithProfile,
  type SessionScope,
} from "../core/request-context.js";
import {
  currentRuntime,
  defineRuntimePart,
  runWithRuntime,
  type Runtime,
} from "../core/runtime.js";
import {
  getRecordWatchIntervalMs,
  getRecordWatchMax,
  getRecordWatchMaxPerSession,
} from "../core/settings.js";

/**
 * N-10 — record watch resources. A client subscribes to
 * servicenow://profiles/{profile}/records/{table}/{sys_id}; the server polls
 * the record's `sys_updated_on` / `sys_mod_count` every
 * SN_RECORD_WATCH_INTERVAL_MS (floor 30 s) and sends
 * notifications/resources/updated when either moves. Polling stops on
 * unsubscribe, on a deleted record (one last notification) and when the
 * session's server closes. Subscriptions are capped per session (one MCP
 * server) and per process; past a cap the subscribe fails with WATCH_LIMIT.
 * Every poll is a getRecord, so the table policy applies as it does to
 * servicenow_get_record.
 */

export const RECORD_TEMPLATE =
  "servicenow://profiles/{profile}/records/{table}/{sys_id}";

const RECORD_URI =
  /^servicenow:\/\/profiles\/([^/]+)\/records\/([^/]+)\/([^/]+)$/;

/** The fields a poll reads: the change marker, nothing else. */
export const WATCH_FIELDS = ["sys_updated_on", "sys_mod_count"];

export interface RecordRef {
  profile: string;
  table: string;
  sysId: string;
}

/** The URI of one record on one profile. */
export function recordUri(
  profile: string,
  table: string,
  sysId: string,
): string {
  return `servicenow://profiles/${profile}/records/${table}/${sysId}`;
}

/** Split a record URI; undefined for any other URI. */
export function parseRecordUri(uri: string): RecordRef | undefined {
  const m = RECORD_URI.exec(uri);
  if (!m) return undefined;
  const [profile, table, sysId] = [m[1], m[2], m[3]].map((s) =>
    decodeURIComponent(s!),
  );
  return { profile: profile!.toLowerCase(), table: table!, sysId: sysId! };
}

interface Watch {
  uri: string;
  ref: RecordRef;
  server: McpServer;
  version: string;
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
  session: SessionScope | undefined;
  runtime: Runtime;
}

/** Every live watch in the process (the global cap counts these). */
const WATCHES = defineRuntimePart(
  "record-watch",
  () => new Set<Watch>(),
  (all) => {
    for (const w of all) {
      clearInterval(w.timer);
      byServer.get(w.server)?.delete(w.uri);
    }
    all.clear();
  },
  { scope: "process" },
);

const byServer = new WeakMap<McpServer, Map<string, Watch>>();
const hooked = new WeakSet<McpServer>();

function stop(watch: Watch): void {
  clearInterval(watch.timer);
  watch.runtime.get(WATCHES).delete(watch);
  byServer.get(watch.server)?.delete(watch.uri);
}

const versionOf = (record: Record<string, unknown>): string =>
  `${snString(record.sys_updated_on)}|${snString(record.sys_mod_count)}`;

function limit(message: string): McpError {
  return new McpError(ErrorCode.InvalidRequest, message, {
    code: "WATCH_LIMIT",
    source: "server",
  });
}

function readVersion(ref: RecordRef): Promise<string> {
  return runWithProfile(ref.profile, async () =>
    versionOf(await getRecord(ref.table, ref.sysId, WATCH_FIELDS)),
  );
}

/** Run `fn` in the watch's session and runtime (the poll has neither). */
function inWatch<T>(watch: Watch, fn: () => T): T {
  const bound = () => runWithRuntime(watch.runtime, fn);
  return watch.session ? runInSession(watch.session, bound) : bound();
}

async function poll(watch: Watch): Promise<void> {
  if (watch.inFlight) return;
  watch.inFlight = true;
  try {
    const version = await inWatch(watch, () => readVersion(watch.ref));
    if (version === watch.version) return;
    watch.version = version;
    await watch.server.server.sendResourceUpdated({ uri: watch.uri });
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "NOT_FOUND" || code === "INSTANCE_HTTP_404") {
      // Deleted: tell the client once (its read now fails) and stop.
      stop(watch);
      await watch.server.server
        .sendResourceUpdated({ uri: watch.uri })
        .catch(() => undefined);
      return;
    }
    logger.debug("Record watch poll failed", {
      uri: watch.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    watch.inFlight = false;
  }
}

/** Stop every watch of a server when it closes (chains any prior handler). */
function hookClose(server: McpServer): void {
  if (hooked.has(server)) return;
  hooked.add(server);
  const previous = server.server.onclose;
  server.server.onclose = () => {
    stopRecordWatches(server);
    previous?.();
  };
}

/**
 * Start watching a record URI for this server. A repeated subscribe is a
 * no-op. Throws WATCH_LIMIT at a cap, UNKNOWN_PROFILE for an unknown profile
 * and the read's own error when the first read fails (policy, not found).
 */
export async function watchRecord(
  server: McpServer,
  uri: string,
): Promise<void> {
  const ref = parseRecordUri(uri);
  if (!ref) return;
  const mine = byServer.get(server) ?? new Map<string, Watch>();
  byServer.set(server, mine);
  if (mine.has(uri)) return;
  if (!listProfiles().includes(ref.profile)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown connection profile "${ref.profile}".`,
      { code: "UNKNOWN_PROFILE", source: "server" },
    );
  }
  const all = currentRuntime().get(WATCHES);
  const perSession = getRecordWatchMaxPerSession();
  if (mine.size >= perSession) {
    throw limit(
      `This session already watches ${mine.size} records (SN_RECORD_WATCH_MAX_PER_SESSION=${perSession}); unsubscribe one first.`,
    );
  }
  const max = getRecordWatchMax();
  if (all.size >= max) {
    throw limit(
      `The server already watches ${all.size} records (SN_RECORD_WATCH_MAX=${max}).`,
    );
  }
  let version: string;
  try {
    version = await readVersion(ref);
  } catch (error) {
    if (error instanceof McpError) throw error;
    const code = errorCodeOf(error);
    throw new McpError(
      code === "NOT_FOUND" || code === "INSTANCE_HTTP_404"
        ? ErrorCode.InvalidParams
        : ErrorCode.InternalError,
      error instanceof Error ? error.message : String(error),
      {
        code,
        source: error instanceof ServiceNowError ? "servicenow" : "server",
      },
    );
  }
  // Re-check after the await: a concurrent subscribe may have won.
  if (mine.has(uri)) return;
  if (mine.size >= perSession || all.size >= max) {
    throw limit("Record watch limit reached.");
  }
  const watch: Watch = {
    uri,
    ref,
    server,
    version,
    inFlight: false,
    session: currentSession(),
    runtime: currentRuntime(),
    timer: setInterval(() => void poll(watch), getRecordWatchIntervalMs()),
  };
  watch.timer.unref?.();
  mine.set(uri, watch);
  all.add(watch);
  hookClose(server);
}

/** Stop watching a record URI for this server (no-op when not watched). */
export function unwatchRecord(server: McpServer, uri: string): void {
  const watch = byServer.get(server)?.get(uri);
  if (watch) stop(watch);
}

/** Stop every watch of one server. */
export function stopRecordWatches(server: McpServer): void {
  for (const watch of [...(byServer.get(server)?.values() ?? [])]) stop(watch);
}

/** Live watches: this server's, and the process total (tests, status). */
export function recordWatchCounts(server?: McpServer): {
  session: number;
  total: number;
} {
  return {
    session: server ? (byServer.get(server)?.size ?? 0) : 0,
    total: currentRuntime().get(WATCHES).size,
  };
}
