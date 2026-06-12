import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../core/logging.js";
import { fail, type ToolResult } from "./result.js";

/** The MCP behaviour hints every tool must declare. */
export interface ToolAnnotationSet {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
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
   * Optional zod output shape (MCP outputSchema). Handlers of such tools must
   * return structuredContent matching it — use okStructured().
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
 * Execute a spec's handler with structured logging and uniform error mapping
 * (the former tools/util.ts runTool, absorbed by the manifest layer).
 */
export async function runSpec(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const fields = spec.logFields?.(args) ?? {};
  const start = Date.now();
  logger.debug(`tool ${spec.name} start`, fields);
  try {
    const result = await spec.handler(args);
    logger.info(`tool ${spec.name} done`, {
      ...fields,
      ms: Date.now() - start,
      isError: result.isError ?? false,
    });
    return result;
  } catch (error) {
    logger.warn(`tool ${spec.name} error`, {
      ...fields,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(error);
  }
}
