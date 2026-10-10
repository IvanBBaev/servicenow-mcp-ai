/**
 * N-35 — subscriptions/listen on the 2026-07-28 wire (basic/patterns/
 * subscriptions, cancellation, ext-tasks). The SDK entries (serveStdio,
 * createMcpHandler) already serve the stream: the acknowledgement comes
 * first, every notification on it carries the subscription ID, the filter
 * is narrowed to what the server can honour, and a teardown answers the
 * listen request with a completion result. This module adds the two parts
 * the SDK leaves out, at the wire seam so the legacy (2025) wire never
 * meets them:
 *
 * - a `taskIds` filter from a client that did not declare the tasks
 *   extension in that request's clientCapabilities is refused with -32021
 *   (tasks-28/33). The SDK's filter schema strips the key, so a declaring
 *   client gets it honoured as empty: M-9 pushes no notifications/tasks,
 *   task status is polled with tasks/get.
 * - after the completion result of a server-initiated teardown, a
 *   notifications/cancelled referencing the listen request (cancel-01).
 *   The result goes first, so a client that honours graceful closure still
 *   sees it; the late cancellation is for an already completed request,
 *   which receivers ignore (cancel-10).
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type McpHttpHandler,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

/** The ext-tasks capability key a client declares under `extensions`. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

const LISTEN = "subscriptions/listen";
const TEARDOWN_REASON = "Subscription closed by the server.";

type Meta = Record<string, unknown>;

const asRecord = (value: unknown): Meta | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Meta)
    : undefined;

/**
 * The -32021 answer to a modern subscriptions/listen that asks for task
 * notifications (`taskIds`, even empty) without declaring the tasks
 * extension; undefined for every other message.
 */
export function listenRejection(
  message: unknown,
): JSONRPCErrorResponse | undefined {
  if (!isJSONRPCRequest(message) || message.method !== LISTEN) return;
  const params = asRecord(message.params);
  const meta = asRecord(params?._meta);
  // A claim-less request belongs to the legacy era, which has no listen.
  if (meta?.[PROTOCOL_VERSION_META_KEY] === undefined) return;
  const filter = asRecord(params?.notifications);
  if (!filter || !("taskIds" in filter)) return;
  const capabilities = asRecord(meta[CLIENT_CAPABILITIES_META_KEY]);
  const extensions = asRecord(capabilities?.extensions);
  if (extensions && TASKS_EXTENSION in extensions) return;
  const error = new MissingRequiredClientCapabilityError(
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    "Task status notifications need the io.modelcontextprotocol/tasks extension.",
  );
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: error.code, message: error.message, data: error.data },
  };
}

/**
 * The notifications/cancelled that follows the completion result of a
 * listen stream the server ended; undefined for every other message.
 */
export function listenTeardownCancel(
  message: unknown,
): JSONRPCNotification | undefined {
  if (!isJSONRPCResultResponse(message)) return;
  const meta = asRecord(message.result._meta);
  if (meta?.[SUBSCRIPTION_ID_META_KEY] === undefined) return;
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {
      requestId: message.id,
      reason: TEARDOWN_REASON,
    },
  };
}

/**
 * Wraps the stdio wire handed to serveStdio: refused listen requests are
 * answered here and never reach the entry; a listen completion result is
 * followed by its cancellation.
 */
export function guardListenWire(inner: Transport): Transport {
  const wire: Transport = {
    async start() {
      inner.onmessage = (message, extra) => {
        const rejection = listenRejection(message);
        if (!rejection) return wire.onmessage?.(message, extra);
        inner.send(rejection).catch((error: Error) => wire.onerror?.(error));
      };
      inner.onerror = (error) => wire.onerror?.(error);
      inner.onclose = () => wire.onclose?.();
      await inner.start();
    },
    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      await inner.send(message, options);
      const cancel = listenTeardownCancel(message);
      if (cancel) await inner.send(cancel);
    },
    close: () => inner.close(),
    setProtocolVersion: (version: string) =>
      inner.setProtocolVersion?.(version),
  };
  return wire;
}

const encoder = new TextEncoder();
const FRAME_END = "\n\n";

/** The JSON-RPC message of one SSE frame, or undefined (keepalive, comment). */
function frameMessage(frame: string): unknown {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  try {
    return JSON.parse(data);
  } catch {
    return;
  }
}

/** An SSE body with the cancellation frame after a listen completion. */
function withTeardownCancel(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    controller.enqueue(encoder.encode(frame + FRAME_END));
    const cancel = listenTeardownCancel(frameMessage(frame));
    if (cancel) {
      controller.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify(cancel)}${FRAME_END}`,
        ),
      );
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let end = pending.indexOf(FRAME_END);
        while (end !== -1) {
          emit(pending.slice(0, end), controller);
          pending = pending.slice(end + FRAME_END.length);
          end = pending.indexOf(FRAME_END);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(pending));
      },
    }),
  );
}

/** The parsed body of a POST, without consuming the original request. */
async function bodyOf(request: Request, parsedBody: unknown): Promise<unknown> {
  if (parsedBody !== undefined) return parsedBody;
  if (request.method !== "POST") return;
  try {
    return await request.clone().json();
  } catch {
    return; // the entry answers the parse error
  }
}

/**
 * Wraps the modern HTTP handler's fetch: refused listen requests get the
 * -32021 error (HTTP 400, the SDK's status for that code) and a listen
 * stream gets its cancellation after the completion result.
 */
export function guardListenFetch(
  fetch: McpHttpHandler["fetch"],
): McpHttpHandler["fetch"] {
  return async (request, options) => {
    const rejection = listenRejection(
      await bodyOf(request, options?.parsedBody),
    );
    if (rejection) return Response.json(rejection, { status: 400 });
    const response = await fetch(request, options);
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !type.startsWith("text/event-stream")) {
      return response;
    }
    return new Response(withTeardownCancel(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
