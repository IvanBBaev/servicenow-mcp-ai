/**
 * N-38 — cache hints (MCP 2026-07-28, caching.mdx). On the 2026-07-28 wire
 * the cacheable results (server/discover, tools/list, prompts/list,
 * resources/list, resources/templates/list, resources/read) carry `ttlMs`
 * and `cacheScope`; the SDK fills them from these hints at its era-aware
 * encode seam, so the legacy (2025) wire never carries either field.
 *
 * Constants, not settings. The tool, prompt and template lists change only
 * on a package toggle, which already sends `list_changed`. resources/list
 * grows with the schema cache and the docs store, so it is not cached (a
 * known deviation). server/discover embeds the host and the credential
 * state in its instructions, so it is private.
 */
import type { CacheHint, ServerOptions } from "@modelcontextprotocol/server";

const FIVE_MINUTES_MS = 300_000;
const ONE_HOUR_MS = 3_600_000;

/** The per-operation hints, as `ServerOptions.cacheHints`. */
export const LIST_CACHE_HINTS: NonNullable<ServerOptions["cacheHints"]> = {
  "server/discover": { ttlMs: FIVE_MINUTES_MS, cacheScope: "private" },
  "tools/list": { ttlMs: FIVE_MINUTES_MS, cacheScope: "public" },
  "prompts/list": { ttlMs: FIVE_MINUTES_MS, cacheScope: "public" },
  "resources/templates/list": { ttlMs: FIVE_MINUTES_MS, cacheScope: "public" },
  "resources/list": { ttlMs: 0, cacheScope: "private" },
  // The default for a read; static references override it per resource.
  "resources/read": { ttlMs: 0, cacheScope: "private" },
};

/**
 * The per-resource hint of a static, user-data-free reference resource
 * (registerResource config `cacheHint`); it wins over the resources/read
 * default above.
 */
export const STATIC_RESOURCE_HINT: CacheHint = {
  ttlMs: ONE_HOUR_MS,
  cacheScope: "public",
};
