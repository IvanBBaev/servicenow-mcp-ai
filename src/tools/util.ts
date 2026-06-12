import { logger } from "../logging.js";
import { fail, type ToolResult } from "../result.js";

/**
 * Wrap a tool handler with structured logging and uniform error handling.
 * Never put secrets or raw encoded queries in `fields` — they reach the logs.
 */
export async function runTool(
  name: string,
  fields: Record<string, unknown>,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const start = Date.now();
  logger.debug(`tool ${name} start`, fields);
  try {
    const result = await fn();
    logger.info(`tool ${name} done`, {
      ...fields,
      ms: Date.now() - start,
      isError: result.isError ?? false,
    });
    return result;
  } catch (error) {
    logger.warn(`tool ${name} error`, {
      ...fields,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(error);
  }
}
