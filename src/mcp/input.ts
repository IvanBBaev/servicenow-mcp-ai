import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
  type ServerOptions,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/server";
import { getPlanTokenTtlSec } from "../core/settings.js";
import { getServer } from "./context.js";
import { canonicalJson } from "./plan-token.js";

/**
 * The one place this server asks the client for input (elicitation). Every
 * other module goes through askUser(); a lint test keeps the SDK's
 * server→client request APIs (elicitInput, createMessage, listRoots) here.
 *
 * Two wires, one question:
 *
 * - **Legacy (2025-era, `initialize` handshake)** — exactly the former
 *   in-line code: a client that declared `elicitation` at initialize gets an
 *   `elicitation/create` request mid-call and the answer comes back on the
 *   same call.
 * - **Modern (2026-07-28, MRTR)** — a server→client request is not allowed
 *   mid-call. The first round answers `input_required` with the embedded
 *   elicitation and a signed `requestState`; the client asks the user and
 *   retries the same call with `inputResponses` and the echoed state. The
 *   state is attacker-controlled on re-entry, so it is HMAC-signed with a
 *   per-process random key, bound to the method and the authenticated client,
 *   expires with the plan-token TTL, names the purpose, tool and profile, binds
 *   the arguments through a keyed digest (set_credentials' arguments carry a
 *   password, so never a plain hash — the state body is readable by the
 *   client) and carries a single-use nonce held here.
 */

/** The first protocol revision of the MRTR era. ISO dates order lexically. */
const MODERN_REVISION = "2026-07-28";

/**
 * How long a legacy elicitation may wait for its answer: the SDK default,
 * pinned here because it is the only request this server ever sends. It is a
 * hard cap — progress never extends it — so a client that never answers
 * cannot hold the call (and its plan) open.
 */
export const ELICIT_TIMEOUT_MS = 60_000;

/** Issued, unused nonces held at once; the oldest is dropped beyond this. */
export const INPUT_NONCE_MAX = 1000;

/** The per-process key: signs requestState and keys the argument digest. */
const KEY = randomBytes(32);

/** The schema of a form-mode question (flat primitives only, per spec). */
export type QuestionSchema = ElicitRequestFormParams["requestedSchema"];

/** What a multi-round question binds its answer to. */
export interface QuestionBinding {
  tool: string;
  profile: string;
  /** The call's arguments; only their keyed digest leaves the process. */
  args: Record<string, unknown>;
}

export interface Question {
  /** Why the server asks; a state minted for one purpose answers no other. */
  purpose: "destructive_apply" | "credential_change";
  /** The inputRequests key on the modern wire. */
  key: string;
  message: string;
  requestedSchema: QuestionSchema;
  binding: QuestionBinding;
}

/**
 * The outcome of a question:
 * - `answered` — the user answered (accept / decline / cancel);
 * - `unsupported` — this client cannot be asked (no form elicitation);
 * - `failed` — the prompt failed at the protocol level (legacy wire);
 * - `rejected` — a modern retry whose state is not acceptable (replayed,
 *   minted for another call, responses without a state);
 * - `pending` — a modern round (the first, or a retry without the answer,
 *   asked again): return `result` as is.
 */
export type Answer =
  | {
      status: "answered";
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }
  | { status: "unsupported" }
  | { status: "failed"; error: string }
  | { status: "rejected"; error: string }
  | { status: "pending"; result: InputRequiredResult };

/** A tool call served on the 2026-07-28 wire, as askUser needs it. */
export interface InputRound {
  /** The request's own client capabilities (its `_meta` envelope). */
  capabilities: ClientCapabilities | undefined;
  /** `inputResponses` of a retry. */
  responses: Record<string, unknown> | undefined;
  /** The echoed requestState: decoded by the verify hook, else raw. */
  state: unknown;
  /** The request context the state is bound to. */
  ctx: ServerContext;
}

interface StatePayload {
  v: 1;
  purpose: Question["purpose"];
  tool: string;
  profile: string;
  /** Keyed HMAC of the canonical arguments. */
  args: string;
  nonce: string;
}

const rounds = new AsyncLocalStorage<InputRound | undefined>();

/**
 * The input round of a tool call, or undefined on the legacy wire. The era
 * is a property of the server instance: one served on 2026-07-28 reports
 * that revision; an `initialize`-negotiated one reports a 2025 revision.
 */
export function inputRoundFromContext(
  ctx: ServerContext,
  server: McpServer | undefined,
): InputRound | undefined {
  const version = server?.server.getNegotiatedProtocolVersion();
  if (version === undefined || version < MODERN_REVISION) return undefined;
  const req = ctx.mcpReq;
  return {
    capabilities: (req.envelope as Record<string, unknown> | undefined)?.[
      CLIENT_CAPABILITIES_META_KEY
    ] as ClientCapabilities | undefined,
    responses: req.inputResponses,
    state: req.requestState(),
    ctx,
  };
}

/** Run `fn` with the call's input round (undefined: the legacy wire). */
export function runWithInputRound<T>(
  round: InputRound | undefined,
  fn: () => T,
): T {
  return rounds.run(round, fn);
}

/** True while a tool call served on the 2026-07-28 wire runs. */
export function onModernWire(): boolean {
  return rounds.getStore() !== undefined;
}

// --- requestState ----------------------------------------------------------

/** The binding value: the method plus the authenticated client, if any. */
const bind = (ctx: ServerContext): string =>
  `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ""}`;

/** A codec for the current TTL (the TTL only matters when minting). */
const codec = () =>
  createRequestStateCodec<StatePayload>({
    key: KEY,
    ttlSeconds: getPlanTokenTtlSec(),
    bind,
  });

/**
 * The ServerOptions MRTR needs, spread into the McpServer options:
 * `requestState.verify` refuses a tampered, expired or rebound state with
 * -32602 before the handler runs, and `legacyShim: false` keeps the legacy
 * wire on the in-line elicitation path (askUser never returns `pending`
 * there).
 */
export function mrtrServerOptions(): Pick<
  ServerOptions,
  "inputRequired" | "requestState"
> {
  const verifier = codec();
  return {
    inputRequired: { legacyShim: false },
    requestState: { verify: (state, ctx) => verifier.verify(state, ctx) },
  };
}

function argsDigest(args: Record<string, unknown>): string {
  return createHmac("sha256", KEY)
    .update(`servicenow-mcp.input.args:${canonicalJson(args)}`)
    .digest("base64url");
}

// Issued nonces → expiry (epoch ms). A nonce is deleted on its first use, so
// a replayed state finds nothing. Per process, like the key.
const nonces = new Map<string, number>();

function issueNonce(): string {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonces) {
    if (expiresAt <= now) nonces.delete(nonce);
  }
  while (nonces.size >= INPUT_NONCE_MAX) {
    const oldest = nonces.keys().next().value;
    if (oldest === undefined) break;
    nonces.delete(oldest);
  }
  const nonce = randomBytes(18).toString("base64url");
  nonces.set(nonce, now + getPlanTokenTtlSec() * 1000);
  return nonce;
}

function useNonce(nonce: string): boolean {
  const expiresAt = nonces.get(nonce);
  nonces.delete(nonce);
  return expiresAt !== undefined && expiresAt > Date.now();
}

function isPayload(value: unknown): value is StatePayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.purpose === "string" &&
    typeof p.tool === "string" &&
    typeof p.profile === "string" &&
    typeof p.args === "string" &&
    typeof p.nonce === "string"
  );
}

// --- askUser ---------------------------------------------------------------

/** Ask the user `question` on whichever wire the current call is served. */
export async function askUser(question: Question): Promise<Answer> {
  const round = rounds.getStore();
  return round ? askModern(round, question) : askLegacy(question);
}

async function askLegacy(question: Question): Promise<Answer> {
  const server = getServer();
  if (!server || !server.server.getClientCapabilities()?.elicitation) {
    return { status: "unsupported" };
  }
  try {
    const res = await server.server.elicitInput(
      {
        message: question.message,
        requestedSchema: question.requestedSchema,
      },
      {
        timeout: ELICIT_TIMEOUT_MS,
        maxTotalTimeout: ELICIT_TIMEOUT_MS,
        resetTimeoutOnProgress: false,
      },
    );
    return {
      status: "answered",
      action: res.action,
      ...(res.content ? { content: res.content } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Form elicitation is declared by `elicitation.form`, or by a bare
 * `elicitation: {}` (the spec's lenient reading); `{url}` alone is not enough.
 */
function canElicitForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation as
    | Record<string, unknown>
    | undefined;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

async function askModern(
  round: InputRound,
  question: Question,
): Promise<Answer> {
  // The server MUST NOT ask for input the request did not declare.
  if (!canElicitForm(round.capabilities)) return { status: "unsupported" };
  const { binding } = question;
  const digest = argsDigest(binding.args);

  if (round.state === undefined) {
    // An answered account link (requestUrlElicitation) carries no state.
    const answered = Object.keys(round.responses ?? {}).filter(
      (key) => key !== LINK_KEY,
    );
    if (answered.length > 0) {
      return {
        status: "rejected",
        error: "the retry carried input responses without its requestState",
      };
    }
    return ask(round, question, digest);
  }

  // The verify hook (mrtrServerOptions) has decoded the state already; a
  // server built without it hands the raw string through, verified here.
  let payload: unknown = round.state;
  if (typeof payload === "string") {
    try {
      payload = await codec().verify(payload, round.ctx);
    } catch (error) {
      return {
        status: "rejected",
        error: `the requestState is invalid (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  if (!isPayload(payload)) {
    return { status: "rejected", error: "the requestState is invalid" };
  }
  // At most once: the nonce goes on the first sight, whatever follows.
  const fresh = useNonce(payload.nonce);
  const mismatch =
    payload.purpose !== question.purpose
      ? "another prompt"
      : payload.tool !== binding.tool
        ? "another tool"
        : payload.profile !== binding.profile
          ? "another profile"
          : payload.args !== digest
            ? "other arguments"
            : undefined;
  if (mismatch) {
    return {
      status: "rejected",
      error: `the requestState was issued for ${mismatch}`,
    };
  }
  if (!fresh) {
    return {
      status: "rejected",
      error: "the requestState was already used or has expired",
    };
  }
  const response = inputResponse(round.responses, question.key);
  // A valid retry without the answer is asked again (fresh nonce), not
  // refused: the spent state cannot be reused either way.
  if (response.kind !== "elicit") return ask(round, question, digest);
  return {
    status: "answered",
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}

/** One `input_required` round: the question and a freshly minted state. */
async function ask(
  round: InputRound,
  question: Question,
  digest: string,
): Promise<Answer> {
  const { binding } = question;
  const payload: StatePayload = {
    v: 1,
    purpose: question.purpose,
    tool: binding.tool,
    profile: binding.profile,
    args: digest,
    nonce: issueNonce(),
  };
  const requestState = await codec().mint(payload, round.ctx);
  return {
    status: "pending",
    result: inputRequired({
      inputRequests: {
        [question.key]: inputRequired.elicit({
          message: question.message,
          requestedSchema: question.requestedSchema,
        }),
      },
      requestState,
    }),
  };
}

// --- URL elicitation (N-17) ------------------------------------------------

/** The inputRequests key of the account-link round on the modern wire. */
export const LINK_KEY = "servicenow_link";

/** A URL the user must open out of band (the ServiceNow account link). */
export interface UrlLink {
  url: string;
  elicitationId: string;
  message: string;
}

/**
 * Send the user to `link.url`, on whichever wire the current call is served:
 * - modern — an `input_required` round with a URL elicitation, returned as the
 *   tool's result; the client opens the URL and retries the same call. No
 *   requestState: the retry is answered by whatever the link stored, never by
 *   the response itself;
 * - legacy — throws the SDK's UrlElicitationRequiredError, which it
 *   answers as is;
 * - undefined when the client declared no URL elicitation: the caller falls
 *   back to a plain error that carries the URL.
 */
export function requestUrlElicitation(
  link: UrlLink,
): InputRequiredResult | undefined {
  const round = rounds.getStore();
  if (round) {
    const elicitation = round.capabilities?.elicitation as
      | Record<string, unknown>
      | undefined;
    if (elicitation?.url === undefined) return undefined;
    return inputRequired({
      inputRequests: {
        [LINK_KEY]: inputRequired.elicitUrl({
          message: link.message,
          url: link.url,
        }),
      },
    });
  }
  const elicitation = getServer()?.server.getClientCapabilities()
    ?.elicitation as Record<string, unknown> | undefined;
  if (elicitation?.url === undefined) return undefined;
  throw new UrlElicitationRequiredError([
    {
      mode: "url",
      elicitationId: link.elicitationId,
      url: link.url,
      message: link.message,
    },
  ]);
}

/** True when `result` is a modern-wire `input_required` round. */
export function isPendingInput(result: unknown): result is InputRequiredResult {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { resultType?: unknown }).resultType === "input_required"
  );
}
