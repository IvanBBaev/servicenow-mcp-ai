import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logging.js";

/**
 * E-3 — the runtime container (closes A2-3, L1-04, L6-04).
 *
 * Every piece of long-lived, mutable process state — the schema LRU cache,
 * cached OAuth tokens, the per-host request semaphore and circuit breakers,
 * the undici dispatchers (proxy / TLS connection pools), HTTP telemetry, the
 * credential profile store and the plugin-availability map — lives in a
 * `Runtime` instead of a module singleton. `createRuntime()` builds an empty
 * one; the bootstrap builds exactly one, installs it and hands it to
 * `registerAllTools`, and tests build their own for isolation.
 *
 * The state is declared where it is used, as a *part*: `defineRuntimePart()`
 * names it, says how to create it and how `dispose()` clears it. A runtime
 * creates a part lazily on first access, so this module imports nothing from
 * the modules that own the state (no import cycles, types stay private) and a
 * layer above core (api/plugin.ts) can own a part without core importing it.
 *
 * Module-level functions (`cached`, `withSlot`, `getTelemetry`, …) keep their
 * signatures and resolve their state through `currentRuntime()`: the runtime a
 * tool call is bound to (`runWithRuntime`, set by `registerAllTools`), else
 * the installed process runtime. H-7 binds a runtime per HTTP session through
 * the same accessor.
 */

export type Disposer = () => void | Promise<void>;

/** A named slot of runtime state; see `defineRuntimePart`. */
export interface RuntimePart<T> {
  readonly name: string;
  readonly create: () => T;
  /** Clear the part in place on `dispose()`; omitted = survives dispose. */
  readonly dispose?: (state: T) => void | Promise<void>;
  /**
   * H-7 — `"process"` state is shared by every HTTP session: a session
   * runtime (`createRuntime({ parent })`) delegates it to its parent, so the
   * connection pools, breakers, token and schema caches stay one per process
   * (keyed by profile + host). `"session"` (the default) is private to each
   * runtime: package toggles, plan tokens, tasks, write counters.
   */
  readonly scope: RuntimeScope;
}

export type RuntimeScope = "process" | "session";

export interface RuntimePartOptions {
  /** See `RuntimePart.scope`; defaults to `"session"`. */
  scope?: RuntimeScope;
}

/** Every part defined so far, in definition order (= dispose order). */
const parts: RuntimePart<unknown>[] = [];

/**
 * Declare a piece of runtime state. Call once at module top level; the
 * returned handle is the key the state is looked up by in any runtime.
 */
export function defineRuntimePart<T>(
  name: string,
  create: () => T,
  dispose?: (state: T) => void | Promise<void>,
  options: RuntimePartOptions = {},
): RuntimePart<T> {
  const part: RuntimePart<T> = {
    name,
    create,
    dispose,
    scope: options.scope ?? "session",
  };
  parts.push(part as RuntimePart<unknown>);
  return part;
}

export interface Runtime {
  /** This runtime's instance of `part`, created on first access. */
  get<T>(part: RuntimePart<T>): T;
  /**
   * Register extra teardown that runs after every part is cleared; a
   * throwing disposer is logged and does not stop the others. Returns an
   * unregister function. Registrations survive `dispose()`.
   */
  onDispose(fn: Disposer): () => void;
  /**
   * Clear every part (queued waiters fail with BUSY, pools are closed, caches
   * and counters are dropped) and run the registered disposers. Idempotent,
   * safe with nothing initialised; concurrent calls share one run. The
   * runtime stays usable afterwards — the next access starts from empty state.
   */
  dispose(): Promise<void>;
  /** The runtime process-scoped parts are delegated to, when this is a child. */
  readonly parent?: Runtime;
}

export interface CreateRuntimeOptions {
  /**
   * H-7 — build a session runtime: process-scoped parts resolve through
   * `parent`, and this runtime's `dispose()` clears only its own
   * (session-scoped) parts, never the shared ones.
   */
  parent?: Runtime;
}

class RuntimeImpl implements Runtime {
  private readonly state = new Map<RuntimePart<unknown>, unknown>();
  private readonly disposers = new Set<Disposer>();
  private inFlight: Promise<void> | null = null;

  constructor(readonly parent?: Runtime) {}

  get<T>(part: RuntimePart<T>): T {
    if (this.parent && part.scope === "process") return this.parent.get(part);
    const key = part as RuntimePart<unknown>;
    if (!this.state.has(key)) this.state.set(key, part.create());
    return this.state.get(key) as T;
  }

  onDispose(fn: Disposer): () => void {
    this.disposers.add(fn);
    return () => {
      this.disposers.delete(fn);
    };
  }

  dispose(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.runDispose().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runDispose(): Promise<void> {
    const steps: Array<[string, Disposer]> = [];
    for (const part of parts) {
      const clear = part.dispose;
      if (!clear || !this.state.has(part)) continue;
      steps.push([part.name, () => clear(this.state.get(part))]);
    }
    [...this.disposers].forEach((fn, i) => {
      steps.push([`registered#${i + 1}`, fn]);
    });
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        logger.warn("dispose step failed", {
          step,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** Build an empty runtime. Nothing is allocated until a part is first used. */
export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  return new RuntimeImpl(options.parent);
}

let installed: Runtime | null = null;
const bound = new AsyncLocalStorage<Runtime>();

/**
 * Make `runtime` the process runtime (the bootstrap does this once; tests do
 * it for a clean slate). Returns the previously installed runtime, if any —
 * it is not disposed here.
 */
export function installRuntime(runtime: Runtime): Runtime | null {
  const prev = installed;
  installed = runtime;
  return prev;
}

/** Run `fn` with `runtime` as the current runtime for its whole async scope. */
export function runWithRuntime<T>(runtime: Runtime, fn: () => T): T {
  return bound.run(runtime, fn);
}

/**
 * The runtime in effect: the one the current call is bound to, else the
 * installed process runtime (created on first use for entry points that
 * never install one, such as the CLI subcommands).
 */
export function currentRuntime(): Runtime {
  return bound.getStore() ?? (installed ??= createRuntime());
}
