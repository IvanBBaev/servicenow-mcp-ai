/**
 * N-35 (base-34, errors-07) — spec-schema failures as -32602. The SDK checks
 * a spec request (prompts/get, completion/complete, …) against its wire schema
 * before our handler runs, but reports a failure as a plain `Error` whose
 * message is the zod issue list as multi-line JSON; the dispatcher then
 * answers -32603 with that dump. A request missing a required field is the
 * client's error, so this maps exactly that failure to -32602 with one
 * concise line. The SDK's own tools/call check already answers -32602 but
 * with the same dump after an `Invalid tools/call request:` prefix; that one
 * is shortened the same way. Any other error passes through untouched.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from "@modelcontextprotocol/server";

type Handler = (request: unknown, ctx: unknown) => Promise<unknown>;
interface Wrappable {
  _wrapHandler(method: string, handler: Handler): Handler;
}

interface Issue {
  code: string;
  message: string;
  path: unknown[];
}

function isIssue(value: unknown): value is Issue {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    Array.isArray(v.path)
  );
}

/**
 * The zod issues an SDK validation error carries, or undefined: a plain
 * `Error` whose message is the issue list, or a -32602 `ProtocolError` whose
 * message is `<prefix>: <issue list>`.
 */
export function schemaIssues(error: unknown): Issue[] | undefined {
  if (!(error instanceof Error)) return;
  const text = error.message.trim();
  let json = text;
  if (error instanceof ProtocolError) {
    if (error.code !== Number(ProtocolErrorCode.InvalidParams)) return;
    const at = text.indexOf(": [");
    if (at < 0) return;
    json = text.slice(at + 2);
  }
  if (!json.startsWith("[")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // swallowed: not JSON; not a zod issue list
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;
  return parsed.every(isIssue) ? parsed : undefined;
}

/** One line: the first issue, with its path, and how many more there are. */
export function invalidParamsError(
  method: string,
  issues: Issue[],
): ProtocolError {
  const [first] = issues as [Issue, ...Issue[]];
  const path = first.path.map(String).join(".");
  const where = path ? `${path}: ` : "";
  const detail = first.message.replace(/\s+/g, " ").trim();
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Invalid params for ${method}: ${where}${detail}${more}.`.replace(
      /\.\.$/,
      ".",
    ),
  );
}

/**
 * Install the mapping on `server` before any handler is registered: the SDK
 * passes every stored handler (validation included) through `_wrapHandler`,
 * and the mapping sits outside the SDK's own wrapper.
 */
export function mapSchemaErrorsToInvalidParams(server: McpServer): void {
  const inner = server.server as unknown as Wrappable;
  const wrap = inner._wrapHandler.bind(inner);
  inner._wrapHandler = (method, handler) => {
    const wrapped = wrap(method, handler);
    return async (request, ctx) => {
      try {
        return await wrapped(request, ctx);
      } catch (error) {
        const issues = schemaIssues(error);
        throw issues ? invalidParamsError(method, issues) : error;
      }
    };
  };
}
