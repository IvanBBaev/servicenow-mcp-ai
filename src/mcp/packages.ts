import type {
  McpServer,
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDeniedPackages } from "../core/settings.js";
import { IntegrationError } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { defineRuntimePart, currentRuntime } from "../core/runtime.js";
import { unwatchRecord, watchRecord } from "./record-watch.js";

/**
 * M-5: dynamic packages. Every policy-permitted tool is registered up front;
 * the ones whose package is not enabled are disabled through the SDK's
 * RegisteredTool handle, so tools/list is exactly the configured surface
 * until a client calls servicenow_enable_package. Toggling a handle makes the
 * SDK emit notifications/tools/list_changed (prompts likewise); the server
 * debounces those so one package toggle is one notification per list.
 *
 * The session never widens the policy axes: denied packages are never
 * registered (and are re-checked against SN_PACKAGES_DENY at enable time),
 * and a read-only package's write tools are never registered at all.
 */

/** The parameterless list_changed notifications the server coalesces per tick. */
export const LIST_CHANGED_NOTIFICATIONS = [
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/resources/list_changed",
];

/** A prompt's package requirement: every `all` package and at least one `any`. */
export interface PromptRequirement {
  all?: string[];
  any?: string[];
}

export function requirementMet(
  req: PromptRequirement,
  enabled: ReadonlySet<string>,
): boolean {
  if (req.all && !req.all.every((p) => enabled.has(p))) return false;
  if (req.any && !req.any.some((p) => enabled.has(p))) return false;
  return true;
}

/** One row of servicenow_list_packages. */
export interface PackageInfo {
  name: string;
  enabled: boolean;
  /** Enabled by SN_TOOL_PACKAGES at startup (the reset target). */
  configured: boolean;
  denied: boolean;
  readOnly: boolean;
  /** Registered tools of the package (write tools are absent when read-only). */
  tools: number;
}

export type PackageErrorCode =
  | "UNKNOWN_PACKAGE"
  | "PACKAGE_DENIED"
  | "PACKAGE_ALWAYS_ON";

/** A refused toggle; `code` rides on the M-2 error contract. */
export class PackageError extends IntegrationError {
  declare readonly code: PackageErrorCode;

  constructor(code: PackageErrorCode, message: string, hint?: string) {
    super(message, undefined, undefined, { code, hint });
    this.name = "PackageError";
  }
}

/** The outcome of an enable/disable call. */
export interface PackageChange {
  package: string;
  enabled: boolean;
  /** False when the package was already in the requested state. */
  changed: boolean;
  readOnly: boolean;
  tools: string[];
  prompts: string[];
}

type ResourceHandle = RegisteredResource | RegisteredResourceTemplate;
type ResourceRegistrar = (server: McpServer) => void;

/**
 * A view of `server` whose registerResource also hands the returned handle to
 * `sink`, so a package registrar can be undone with remove() later.
 */
function recording(
  server: McpServer,
  sink: (handle: ResourceHandle) => void,
): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === "registerResource") {
        return (...args: unknown[]) => {
          const handle = (value as (...a: unknown[]) => ResourceHandle).apply(
            target,
            args,
          );
          sink(handle);
          return handle;
        };
      }
      return typeof value === "function"
        ? ((value as (...a: unknown[]) => unknown).bind(target) as unknown)
        : value;
    },
  });
}

export class PackageSession {
  private readonly tools = new Map<
    string,
    Array<{ name: string; handle: RegisteredTool }>
  >();
  /** M-7: legacy tool-name aliases — toggled with their package, never counted. */
  private readonly aliases = new Map<string, RegisteredTool[]>();
  private readonly registrars = new Map<string, ResourceRegistrar>();
  private readonly resources = new Map<string, ResourceHandle[]>();
  private readonly prompts: Array<{
    name: string;
    requires: PromptRequirement;
    handle: RegisteredPrompt;
  }> = [];
  private readonly enabled: Set<string>;

  constructor(
    readonly server: McpServer,
    private readonly known: readonly string[],
    private readonly configured: ReadonlySet<string>,
    private readonly denied: ReadonlySet<string>,
    private readonly readOnly: ReadonlySet<string>,
  ) {
    this.enabled = new Set(configured);
  }

  /** Track a registered tool; disabled right away when its package is off. */
  addTool(pkg: string, name: string, handle: RegisteredTool): void {
    if (pkg === "admin") return;
    const list = this.tools.get(pkg) ?? [];
    list.push({ name, handle });
    this.tools.set(pkg, list);
    if (!this.enabled.has(pkg) && handle.enabled) handle.disable();
  }

  /**
   * M-7: track a legacy alias of one of `pkg`'s tools. It is enabled and
   * disabled with the package but is not one of its tools (list / change).
   */
  addAlias(pkg: string, handle: RegisteredTool): void {
    if (pkg === "admin") return;
    const list = this.aliases.get(pkg) ?? [];
    list.push(handle);
    this.aliases.set(pkg, list);
    if (!this.enabled.has(pkg) && handle.enabled) handle.disable();
  }

  /**
   * Track a package's resource registrar. Registered now when the package is
   * on; otherwise on enable. (Resource templates ignore `enabled` in the SDK,
   * so package resources are registered and remove()d instead of toggled.)
   */
  addResources(pkg: string, registrar: ResourceRegistrar): void {
    this.registrars.set(pkg, registrar);
    if (this.enabled.has(pkg)) this.registerResources(pkg);
  }

  /** Track a prompt; disabled right away when its requirement is not met. */
  addPrompt(
    name: string,
    requires: PromptRequirement,
    handle: RegisteredPrompt,
  ): void {
    this.prompts.push({ name, requires, handle });
    this.applyPrompt(this.prompts[this.prompts.length - 1]!);
  }

  /** The packages enabled in this session right now, sorted. */
  enabledPackages(): string[] {
    return [...this.enabled].sort();
  }

  /** True once a toggle made the session differ from the configured set. */
  modified(): boolean {
    if (this.enabled.size !== this.configured.size) return true;
    return [...this.enabled].some((p) => !this.configured.has(p));
  }

  list(): PackageInfo[] {
    return this.known.map((name) => ({
      name,
      enabled: this.enabled.has(name),
      configured: this.configured.has(name),
      denied: this.isDenied(name),
      readOnly: this.readOnly.has(name),
      tools: this.tools.get(name)?.length ?? 0,
    }));
  }

  enable(input: string): PackageChange {
    const name = this.check(input);
    if (this.isDenied(name)) {
      throw new PackageError(
        "PACKAGE_DENIED",
        `Package '${name}' is denied by SN_PACKAGES_DENY and cannot be enabled.`,
        `Remove '${name}' from SN_PACKAGES_DENY and restart the server.`,
      );
    }
    const changed = !this.enabled.has(name);
    if (changed) {
      this.enabled.add(name);
      for (const { handle } of this.tools.get(name) ?? []) {
        if (!handle.enabled) handle.enable();
      }
      for (const handle of this.aliases.get(name) ?? []) {
        if (!handle.enabled) handle.enable();
      }
      this.registerResources(name);
      this.applyPrompts();
      logger.info("Package enabled for this session", { package: name });
    }
    return this.change(name, changed);
  }

  disable(input: string): PackageChange {
    const name = this.check(input);
    const changed = this.enabled.has(name);
    if (changed) {
      this.enabled.delete(name);
      for (const { handle } of this.tools.get(name) ?? []) {
        if (handle.enabled) handle.disable();
      }
      for (const handle of this.aliases.get(name) ?? []) {
        if (handle.enabled) handle.disable();
      }
      this.removeResources(name);
      this.applyPrompts();
      logger.info("Package disabled for this session", { package: name });
    }
    return this.change(name, changed);
  }

  /** Return to the configured (SN_TOOL_PACKAGES) set — on session close. */
  reset(): void {
    for (const name of this.known) {
      if (this.configured.has(name) && !this.isDenied(name)) {
        if (!this.enabled.has(name)) this.enable(name);
      } else if (this.enabled.has(name)) {
        this.disable(name);
      }
    }
  }

  private isDenied(name: string): boolean {
    return this.denied.has(name) || getDeniedPackages().includes(name);
  }

  private check(input: string): string {
    const name = input.trim().toLowerCase();
    if (name === "admin") {
      throw new PackageError(
        "PACKAGE_ALWAYS_ON",
        "The admin tools are always on and cannot be toggled.",
      );
    }
    if (!this.known.includes(name)) {
      throw new PackageError(
        "UNKNOWN_PACKAGE",
        `'${input}' is not a package. Known: ${this.known.join(", ")}.`,
      );
    }
    return name;
  }

  private change(name: string, changed: boolean): PackageChange {
    return {
      package: name,
      enabled: this.enabled.has(name),
      changed,
      readOnly: this.readOnly.has(name),
      tools: (this.tools.get(name) ?? []).map((t) => t.name),
      prompts: this.prompts
        .filter((p) => p.handle.enabled)
        .map((p) => p.name)
        .sort(),
    };
  }

  private registerResources(pkg: string): void {
    const registrar = this.registrars.get(pkg);
    if (!registrar || this.resources.has(pkg)) return;
    const handles: ResourceHandle[] = [];
    registrar(recording(this.server, (h) => handles.push(h)));
    this.resources.set(pkg, handles);
  }

  private removeResources(pkg: string): void {
    for (const handle of this.resources.get(pkg) ?? []) handle.remove();
    this.resources.delete(pkg);
  }

  private applyPrompts(): void {
    for (const prompt of this.prompts) this.applyPrompt(prompt);
  }

  private applyPrompt(prompt: {
    requires: PromptRequirement;
    handle: RegisteredPrompt;
  }): void {
    const on = requirementMet(prompt.requires, this.enabled);
    if (on && !prompt.handle.enabled) prompt.handle.enable();
    if (!on && prompt.handle.enabled) prompt.handle.disable();
  }
}

/**
 * The package session of a runtime (one per MCP session under H-7). On
 * runtime dispose — the HTTP session closed — it falls back to the
 * configured set, so a toggle never outlives the session that made it.
 */
const SESSION = defineRuntimePart(
  "packages.session",
  () => ({ current: null as PackageSession | null }),
  (state) => state.current?.reset(),
);

const byServer = new WeakMap<McpServer, PackageSession>();

/** Bind `session` to its server and to the current runtime. */
export function bindPackageSession(
  session: PackageSession,
  runtime = currentRuntime(),
): void {
  byServer.set(session.server, session);
  runtime.get(SESSION).current = session;
}

export function packageSessionOf(server: McpServer): PackageSession | null {
  return byServer.get(server) ?? null;
}

/** The session the current tool call belongs to (null outside a server). */
export function currentPackageSession(): PackageSession | null {
  return currentRuntime().get(SESSION).current;
}

/** Resources whose content follows the active profile. */
const PROFILE_SCOPED_URIS = ["servicenow://status"];

const subscriptions = new WeakMap<McpServer, Set<string>>();

/**
 * Declare `resources.subscribe` + `listChanged` and track subscriptions, so a
 * profile switch can push resources/updated for servicenow://status, and a
 * record URI is polled for changes (N-10). Must run
 * before connect (the SDK refuses capability changes afterwards).
 */
export function enableResourceSubscriptions(server: McpServer): void {
  if (subscriptions.has(server)) return;
  const uris = new Set<string>();
  subscriptions.set(server, uris);
  server.server.registerCapabilities({
    resources: { subscribe: true, listChanged: true },
  });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    // N-10: a record URI starts a poll (and may be refused at a cap).
    await watchRecord(server, request.params.uri);
    uris.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    unwatchRecord(server, request.params.uri);
    uris.delete(request.params.uri);
    return {};
  });
}

/**
 * After a profile change (use_instance, set_credentials): the resource list
 * may name different instance content, and servicenow://status changed —
 * tell the client. Best effort; a closed transport is not an error.
 */
export async function notifyProfileChanged(
  server: McpServer | null,
): Promise<void> {
  if (!server?.isConnected()) return;
  try {
    // Straight to the low-level server: McpServer's wrapper does not await,
    // and a server without resources rejects the notification.
    await server.server.sendResourceListChanged();
    const subscribed = subscriptions.get(server);
    for (const uri of PROFILE_SCOPED_URIS) {
      if (subscribed?.has(uri))
        await server.server.sendResourceUpdated({ uri });
    }
  } catch (error) {
    logger.debug("Profile change notification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
