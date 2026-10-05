import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  assertValidProfileName,
  authEnvKey,
  envFileChoice,
  envKeysFor,
  getCredentials,
  getEnvPath,
  loadEnv,
  persistEnv,
  reloadCredentialsFromEnv,
} from "./core/config.js";
import { resolveHost } from "./core/host.js";
import { SERVER_VERSION } from "./core/identity.js";
import { runWithProfile } from "./core/request-context.js";
import { createRuntime, installRuntime } from "./core/runtime.js";
import {
  applySettingsAtStartup,
  validateSettings,
} from "./core/settings-manifest.js";
import type { DoctorReport } from "./api/doctor.js";

/**
 * D-1 — the command-line interface. `main()` is the only entry: it parses
 * the arguments with `node:util` parseArgs and either runs a subcommand and
 * exits, or (no subcommand) starts the MCP server exactly as before. Importing
 * this module has no side effects; the heavy modules of each subcommand are
 * loaded on demand, so `--help` / `--version` stay fast.
 *
 * Every subcommand writes its result to stdout and diagnostics to stderr;
 * usage errors exit 2.
 */

export const BIN = "servicenow-mcp-ai";

export const USAGE = `Usage: ${BIN} [command] [options]

Without a command, starts the MCP server (stdio by default; SN_TRANSPORT=http
for Streamable HTTP). stdout is then the protocol channel.

Commands:
  init                  Interactive setup: instance, auth method, credentials
                        (hidden prompt); writes the env file, then runs doctor.
                        Answers can be piped on stdin, one per line.
  doctor                Health check: credentials, connectivity, capabilities.
                        Exit 0 healthy / 1 degraded or unreachable / 2 not configured.
  login                 OAuth 2.1 Authorization Code + PKCE login (stores a
                        refresh token).
  drift <a> <b>         Compare two profiles; exit 0 clean / 1 drift / 2 error.
  support-bundle        Write a JSON bundle for a bug report (doctor, redacted
                        settings, npm ls, manifest, log tail); prints its path.

Options:
  -h, --help            Show this help.
  -v, --version         Print the version.
  --profile <name>      Profile for init, doctor, login and support-bundle.
  --json                doctor: print the report as JSON.
  --ascii               doctor: plain ASCII output (automatic when stdout is not
                        a terminal, and on Windows outside Windows Terminal).
  --skip-doctor         init: do not run doctor after writing the env file.
  --out <file>          support-bundle: where to write the bundle.

The env file is SN_ENV_FILE, else ~/.config/servicenow-mcp-ai/.env
(XDG_CONFIG_HOME is honoured).
`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  profile: { type: "string" },
  json: { type: "boolean" },
  ascii: { type: "boolean" },
  "skip-doctor": { type: "boolean" },
  out: { type: "string" },
} as const;

type OptionName = keyof typeof OPTIONS;

export const COMMANDS = [
  "init",
  "doctor",
  "login",
  "drift",
  "support-bundle",
] as const;
export type Command = (typeof COMMANDS)[number];

/** Which options each command accepts (help/version are always accepted). */
const COMMAND_OPTIONS: Record<Command | "serve", OptionName[]> = {
  serve: [],
  init: ["profile", "skip-doctor"],
  doctor: ["profile", "json", "ascii"],
  login: ["profile"],
  drift: [],
  "support-bundle": ["profile", "out"],
};

/** How many positionals (after the command) each command takes. */
const COMMAND_ARITY: Record<Command | "serve", [number, number]> = {
  serve: [0, 0],
  init: [0, 0],
  doctor: [0, 0],
  login: [0, 0],
  drift: [0, 2],
  "support-bundle": [0, 0],
};

export type ParsedCli =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      command: Command | "serve";
      args: string[];
      profile?: string;
      json: boolean;
      ascii: boolean;
      skipDoctor: boolean;
      out?: string;
    };

/** Parse argv (without `node` and the script) into a command. Never throws. */
export function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === "help") return { kind: "help" };
  if (values.version) return { kind: "version" };

  const [first, ...args] = positionals;
  let command: Command | "serve" = "serve";
  if (first !== undefined) {
    if (!(COMMANDS as readonly string[]).includes(first)) {
      return { kind: "error", message: `Unknown command "${first}".` };
    }
    command = first as Command;
  }
  const allowed = new Set<string>(COMMAND_OPTIONS[command]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) {
      return {
        kind: "error",
        message:
          command === "serve"
            ? `Option --${name} needs a command.`
            : `Option --${name} does not apply to "${command}".`,
      };
    }
  }
  const [, max] = COMMAND_ARITY[command];
  if (args.length > max) {
    return {
      kind: "error",
      message: `Too many arguments for "${command}": ${args.join(" ")}`,
    };
  }
  if (values.profile !== undefined) {
    const profile = values.profile.trim().toLowerCase();
    try {
      assertValidProfileName(profile);
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
    values.profile = profile;
  }
  return {
    kind: "run",
    command,
    args,
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    json: values.json === true,
    ascii: values.ascii === true,
    skipDoctor: values["skip-doctor"] === true,
    ...(values.out !== undefined ? { out: values.out } : {}),
  };
}

/** The process streams a command talks to (injectable for tests). */
export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: unknown };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function processIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
  };
}

/** Collaborators a command uses (injectable for tests). */
export interface CliDeps {
  runDoctor: () => Promise<DoctorReport>;
  npm?: () => Promise<unknown>;
  now?: () => Date;
}

async function defaultDeps(): Promise<CliDeps> {
  const { runDoctor } = await import("./api/doctor.js");
  // N-23: the privilege advice needs the package set the server would load.
  const { effectivePackages } = await import("./mcp/registry.js");
  return {
    runDoctor: () => runDoctor({ packages: effectivePackages().enabled }),
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Run `fn` for `profile` when one was given, else for the active profile. */
function forProfile<T>(profile: string | undefined, fn: () => T): T {
  return profile ? runWithProfile(profile, fn) : fn();
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** The `doctor --json` payload: env file, report, checks[] and get_status v2. */
export async function doctorPayload(
  report: DoctorReport,
): Promise<Record<string, unknown>> {
  const { doctorChecks } = await import("./api/doctor.js");
  const { buildStatusPayload } = await import("./mcp/status.js");
  const envFile = envFileChoice();
  // E-4: settings the manifest rejects (the value in force is the default).
  const { issues } = validateSettings(process.env);
  return {
    envFile: {
      path: envFile.path,
      exists: existsSync(envFile.path),
      source: envFile.source,
    },
    ...(issues.length ? { settingsIssues: issues } : {}),
    status: report.status,
    summary: report.summary,
    checks: doctorChecks(report),
    config: report.config,
    ...(report.connection ? { connection: report.connection } : {}),
    ...(report.capabilities ? { capabilities: report.capabilities } : {}),
    ...(report.privilege ? { privilege: report.privilege } : {}),
    serverStatus: buildStatusPayload(),
  };
}

async function cmdDoctor(
  parsed: Extract<ParsedCli, { kind: "run" }>,
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const { EXIT, envFileLine, formatDoctorReport, shouldUseAscii, toAscii } =
    await import("./api/doctor.js");
  try {
    return await forProfile(parsed.profile, async () => {
      const report = await deps.runDoctor();
      if (parsed.json) {
        const payload = await doctorPayload(report);
        io.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      } else {
        const envFile = envFileChoice();
        const { issues } = validateSettings(process.env);
        let text =
          envFileLine(envFile.path, existsSync(envFile.path), envFile.source) +
          "\n" +
          issues.map((i) => `settings ${i.level}: ${i.message}\n`).join("") +
          formatDoctorReport(report).trimEnd() +
          "\n";
        const ascii = shouldUseAscii({
          flag: parsed.ascii,
          isTTY: io.stdout.isTTY === true,
          platform: io.platform,
          env: io.env,
        });
        if (ascii) text = toAscii(text);
        io.stdout.write(text);
      }
      return EXIT[report.status];
    });
  } catch (error) {
    io.stderr.write(`Doctor failed: ${errorText(error)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// login / drift
// ---------------------------------------------------------------------------

async function cmdLogin(
  parsed: Extract<ParsedCli, { kind: "run" }>,
  io: CliIO,
): Promise<number> {
  const { runOAuthLogin } = await import("./core/oauth-login.js");
  try {
    const { host, profile } = await forProfile(parsed.profile, () =>
      runOAuthLogin(),
    );
    io.stderr.write(
      `\n✓ Logged in to ${host} (profile: ${profile}). Refresh token stored — you can start the server now.\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`\n✗ Login failed: ${errorText(error)}\n`);
    return 1;
  }
}

async function cmdDrift(args: string[], io: CliIO): Promise<number> {
  const [a, b] = args;
  if (!a || !b) {
    io.stderr.write(`Usage: ${BIN} drift <profileA> <profileB>\n`);
    return 2;
  }
  const { compareInstances, driftCount } = await import("./api/compare.js");
  try {
    const result = await compareInstances({ a, b });
    io.stdout.write(result.report.trimEnd() + "\n");
    const drift = driftCount(result);
    io.stderr.write(
      `\nDrift: ${drift} difference(s) between "${a}" and "${b}".\n`,
    );
    return drift > 0 ? 1 : 0;
  } catch (error) {
    io.stderr.write(`Drift gate failed: ${errorText(error)}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** Thrown when stdin ends before an answer (non-TTY without piped input). */
export class InputEndedError extends Error {
  constructor() {
    super(
      "stdin ended before all answers were given — run init in an interactive terminal or pipe its answers on stdin, one per line. Nothing was written.",
    );
    this.name = "InputEndedError";
  }
}

/** A writable that forwards to `target` unless muted (hidden prompts). */
class MutableOutput extends Writable {
  muted = false;
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}

/**
 * Line prompts over one readline interface. Lines are consumed through the
 * async iterator, so piped answers that arrive before their question are
 * buffered, not lost. On a terminal a hidden prompt mutes readline's echo.
 */
export interface Prompter {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(io: CliIO): Prompter {
  const output = new MutableOutput(io.stdout);
  const terminal = io.stdin.isTTY === true;
  const rl = createInterface({ input: io.stdin, output, terminal });
  const lines: AsyncIterator<string> = rl[Symbol.asyncIterator]();
  const next = async (): Promise<string> => {
    const line = await lines.next();
    if (line.done === true) throw new InputEndedError();
    return line.value.trim();
  };
  return {
    async ask(question) {
      io.stdout.write(question);
      const answer = await next();
      if (!terminal) io.stdout.write("\n");
      return answer;
    },
    async askHidden(question) {
      io.stdout.write(question);
      output.muted = true;
      try {
        return await next();
      } finally {
        output.muted = false;
        io.stdout.write("\n");
      }
    },
    close() {
      rl.close();
    },
  };
}

export const AUTH_CHOICES = ["basic", "oauth", "apikey", "token"] as const;
export const OAUTH_GRANTS = [
  "client_credentials",
  "password",
  "authorization_code",
] as const;

/** Ask until `accept` returns a value (at most 3 tries). */
async function askValid<T>(
  prompter: Prompter,
  io: CliIO,
  question: string,
  accept: (answer: string) => T | string,
  hidden = false,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = hidden
      ? await prompter.askHidden(question)
      : await prompter.ask(question);
    const result = accept(answer);
    if (typeof result !== "string") return result;
    io.stderr.write(`  ${result}\n`);
  }
  throw new Error("Too many invalid answers — nothing was written.");
}

const required =
  (what: string) =>
  (answer: string): { value: string } | string =>
    answer ? { value: answer } : `${what} is required.`;

const oneOf =
  <T extends string>(choices: readonly T[], fallback: T) =>
  (answer: string): { value: T } | string => {
    const value = (answer || fallback).toLowerCase();
    return (choices as readonly string[]).includes(value)
      ? { value: value as T }
      : `Choose one of: ${choices.join(", ")}.`;
  };

/** The env updates init collects for one profile (secrets included). */
export async function collectInitAnswers(
  prompter: Prompter,
  io: CliIO,
  profile: string,
): Promise<{ updates: Record<string, string>; needsLogin: boolean }> {
  const keys = envKeysFor(profile);
  const key = (suffix: string) => authEnvKey(suffix, profile);
  const updates: Record<string, string> = {};

  const { value: instance } = await askValid(
    prompter,
    io,
    "ServiceNow instance (e.g. dev12345 or dev12345.service-now.com): ",
    (answer) => {
      if (!answer) return "The instance is required.";
      try {
        resolveHost(answer);
        return { value: answer };
      } catch (error) {
        return errorText(error);
      }
    },
  );
  updates[keys.instance] = instance;

  const { value: auth } = await askValid(
    prompter,
    io,
    `Auth method [${AUTH_CHOICES.join("/")}] (basic): `,
    oneOf(AUTH_CHOICES, "basic"),
  );
  updates[key("AUTH")] = auth;

  const ask = async (question: string, what: string, hidden = false) =>
    (await askValid(prompter, io, question, required(what), hidden)).value;

  let needsLogin = false;
  switch (auth) {
    case "basic":
      updates[keys.user] = await ask("User name: ", "The user name");
      updates[keys.password] = await ask(
        "Password (hidden): ",
        "The password",
        true,
      );
      break;
    case "apikey":
      updates[key("API_KEY")] = await ask(
        "API key (hidden): ",
        "The API key",
        true,
      );
      break;
    case "token":
      updates[key("BEARER_TOKEN")] = await ask(
        "Bearer token (hidden): ",
        "The bearer token",
        true,
      );
      break;
    case "oauth": {
      const { value: grant } = await askValid(
        prompter,
        io,
        `OAuth grant [${OAUTH_GRANTS.join("/")}] (client_credentials): `,
        oneOf(OAUTH_GRANTS, "client_credentials"),
      );
      updates[key("OAUTH_CLIENT_ID")] = await ask(
        "OAuth client id: ",
        "The client id",
      );
      if (grant === "authorization_code") {
        // The secret is optional for a public PKCE client; `login` then
        // stores the refresh token and switches the grant.
        const secret = await prompter.askHidden(
          "OAuth client secret (hidden, empty for a public client): ",
        );
        if (secret) updates[key("OAUTH_CLIENT_SECRET")] = secret;
        needsLogin = true;
        break;
      }
      updates[key("OAUTH_CLIENT_SECRET")] = await ask(
        "OAuth client secret (hidden): ",
        "The client secret",
        true,
      );
      updates[key("OAUTH_GRANT")] = grant;
      if (grant === "password") {
        updates[keys.user] = await ask("User name: ", "The user name");
        updates[keys.password] = await ask(
          "Password (hidden): ",
          "The password",
          true,
        );
      }
      break;
    }
  }
  return { updates, needsLogin };
}

async function cmdInit(
  parsed: Extract<ParsedCli, { kind: "run" }>,
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const profile = parsed.profile ?? "default";
  const envFile = getEnvPath();
  io.stdout.write(
    `${BIN} init — profile "${profile}"\nenv file: ${envFile} (${existsSync(envFile) ? "exists" : "new"})\n\n`,
  );
  const prompter = createPrompter(io);
  let result: Awaited<ReturnType<typeof collectInitAnswers>>;
  try {
    if (getCredentials(profile).instance) {
      const answer = await prompter.ask(
        `Profile "${profile}" is already configured. Overwrite it? [y/N]: `,
      );
      if (!/^y(es)?$/i.test(answer)) {
        io.stdout.write("Nothing changed.\n");
        return 0;
      }
    }
    result = await collectInitAnswers(prompter, io, profile);
  } catch (error) {
    io.stderr.write(`init: ${errorText(error)}\n`);
    return 2;
  } finally {
    prompter.close();
  }

  try {
    // The same atomic, 0600, comment-preserving writer as set_credentials;
    // then drop the cached profile snapshots so doctor sees the new values.
    persistEnv(result.updates);
    reloadCredentialsFromEnv();
  } catch (error) {
    io.stderr.write(`init: could not write ${envFile}: ${errorText(error)}\n`);
    return 1;
  }
  // Key names only — never a value.
  io.stdout.write(
    `\nWrote ${Object.keys(result.updates).sort().join(", ")} to ${envFile}\n`,
  );
  if (profile !== "default") {
    io.stdout.write(
      `Use it with --profile ${profile}, SN_ACTIVE_PROFILE=${profile} or servicenow_use_instance.\n`,
    );
  }
  if (result.needsLogin) {
    io.stdout.write(
      `Next: run \`${BIN} login${profile !== "default" ? ` --profile ${profile}` : ""}\` to obtain the refresh token.\n`,
    );
    return 0;
  }
  if (parsed.skipDoctor) return 0;
  io.stdout.write("\n");
  return cmdDoctor({ ...parsed, profile, json: false, ascii: false }, io, deps);
}

// ---------------------------------------------------------------------------
// support-bundle
// ---------------------------------------------------------------------------

/** Default bundle path: `servicenow-mcp-ai-support-<timestamp>.json` in cwd. */
export function defaultBundlePath(cwd: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return resolve(cwd, `${BIN}-support-${stamp}.json`);
}

async function cmdSupportBundle(
  parsed: Extract<ParsedCli, { kind: "run" }>,
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const { buildSupportBundle } = await import("./api/support-bundle.js");
  const { ALL_PACKAGES, ALL_TOOLS, activeToolSpecs } =
    await import("./mcp/registry.js");
  const now = deps.now?.() ?? new Date();
  const out = parsed.out
    ? resolve(io.cwd, parsed.out)
    : defaultBundlePath(io.cwd, now);
  try {
    const text = await forProfile(parsed.profile, async () => {
      let doctor: unknown;
      try {
        doctor = await doctorPayload(await deps.runDoctor());
      } catch (error) {
        doctor = { error: errorText(error) };
      }
      return buildSupportBundle({
        doctor,
        manifest: {
          manifestVersion: 3,
          serverVersion: SERVER_VERSION,
          toolCount: ALL_TOOLS.length,
          packageCount: ALL_PACKAGES.length,
          activeTools: activeToolSpecs()
            .map((t) => t.name)
            .sort(),
        },
        env: io.env,
        ...(deps.npm ? { npm: deps.npm } : {}),
        now,
      });
    });
    writeFileSync(out, text, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    io.stderr.write(`support-bundle failed: ${errorText(error)}\n`);
    return 1;
  }
  io.stdout.write(out + "\n");
  io.stderr.write(
    "Support bundle written. Secrets are masked; review it before attaching it to an issue.\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Run the CLI for `argv`. Resolves with the exit code of a subcommand, or
 * with "serve" when the MCP server should start. The caller has installed a
 * runtime and loaded the env file (see `main`).
 */
export async function runCli(
  argv: string[],
  io: CliIO = processIO(),
  deps?: CliDeps,
): Promise<number | "serve"> {
  const parsed = parseCli(argv);
  switch (parsed.kind) {
    case "help":
      io.stdout.write(USAGE);
      return 0;
    case "version":
      io.stdout.write(SERVER_VERSION + "\n");
      return 0;
    case "error":
      io.stderr.write(`${parsed.message}\n\n${USAGE}`);
      return 2;
  }
  const resolved = deps ?? (await defaultDeps());
  switch (parsed.command) {
    case "serve":
      return "serve";
    case "init":
      return cmdInit(parsed, io, resolved);
    case "doctor":
      return cmdDoctor(parsed, io, resolved);
    case "login":
      return cmdLogin(parsed, io);
    case "drift":
      return cmdDrift(parsed.args, io);
    case "support-bundle":
      return cmdSupportBundle(parsed, io, resolved);
  }
}

/**
 * Process entry (called by build/index.js): install the runtime, load the
 * env file, then run a subcommand and exit, or start the server.
 */
export async function main(argv: string[] = process.argv.slice(2)) {
  // E-3: the one runtime container of this process — caches, tokens, the
  // request queue, breakers, dispatchers, telemetry and the profile store.
  const runtime = createRuntime();
  installRuntime(runtime);
  try {
    loadEnv();
    // E-4: validate every declared setting once; SN_STRICT_SETTINGS=1 turns
    // an invalid value into this startup error instead of a warning.
    applySettingsAtStartup(process.env);
  } catch (error) {
    // D-5: a configuration error (a <KEY> / <KEY>_FILE conflict, an
    // unreadable secret file, a strict-settings failure) is a one-line
    // message, not a stack trace.
    process.stderr.write(`servicenow-mcp-ai: ${errorText(error)}\n`);
    process.exit(1);
  }

  const result = await runCli(argv);
  if (result !== "serve") {
    // Subcommands may leave pooled sockets open; exit explicitly.
    process.exit(result);
  }
  const { startServer } = await import("./server.js");
  const { logger } = await import("./core/logging.js");
  startServer(runtime).catch((error) => {
    logger.error("Fatal error in MCP server", { error: errorText(error) });
    process.exit(1);
  });
}
