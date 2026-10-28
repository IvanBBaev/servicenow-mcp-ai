import type { Icon } from "@modelcontextprotocol/server";

/**
 * A brand-neutral 64×64 icon (three linked nodes on a rounded square), inline
 * as a data URI so no network fetch or bundled asset is needed. Deliberately
 * not the ServiceNow logo.
 */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#1f3a5f"/>' +
  '<path d="M20 44L32 20L44 44Z" fill="none" stroke="#8fd3b6" stroke-width="4" stroke-linejoin="round"/>' +
  '<circle cx="32" cy="20" r="6" fill="#ffffff"/>' +
  '<circle cx="20" cy="44" r="6" fill="#ffffff"/>' +
  '<circle cx="44" cy="44" r="6" fill="#ffffff"/>' +
  "</svg>";

export const SERVER_ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(
  ICON_SVG,
).toString("base64")}`;

/**
 * The icon set of the server, its prompts and its `ui://` views (N-80) —
 * one data URI family so a client picker shows the same mark everywhere.
 * Tools carry none: ≈ 120 B × every tool on `tools/list`.
 */
export const SERVER_ICONS: readonly Icon[] = Object.freeze([
  Object.freeze({
    src: SERVER_ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  }),
]);
