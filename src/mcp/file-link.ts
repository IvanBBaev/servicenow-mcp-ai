/**
 * N-65 — `resource_link` results. A file delivery (S-11: a `format:"file"`
 * result with `{ path, bytes }`, see file-result.ts) gains a second content
 * block that links the written file as `servicenow://docs/<path>`, so a client
 * can read it through resources/read instead of the filesystem. Without the
 * docs package the link points at the always-on `servicenow://exports/<path>`
 * resource instead; with docs denied there is no link. The text block is
 * unchanged either way.
 */
import path from "node:path";
import { DELIVERY_MIME } from "../api/docs-inspect.js";
import { effectivePackages } from "./package-policy.js";
import type { ResourceLinkBlock, ToolResult } from "./result.js";

const MIME: Readonly<Record<string, string>> = DELIVERY_MIME;

/** A file-delivery body: cheap pre-check before the JSON parse. */
const FILE_FORMAT = /"format":\s*"file"/;

/** The link block for a delivered docs-store file, or undefined. */
export function fileLinkOf(
  text: string,
  scheme: "docs" | "exports" = "docs",
): ResourceLinkBlock | undefined {
  if (!FILE_FORMAT.test(text)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { format, path: rel, bytes } = (body ?? {}) as Record<string, unknown>;
  if (format !== "file" || typeof rel !== "string") return undefined;
  const mimeType = MIME[path.posix.extname(rel).toLowerCase()];
  if (!mimeType) return undefined;
  return {
    type: "resource_link",
    uri: `servicenow://${scheme}/${encodeURI(rel)}`,
    name: path.posix.basename(rel),
    mimeType,
    ...(typeof bytes === "number" ? { size: bytes } : {}),
  };
}

/** Append the file's resource_link to a successful file-delivery result. */
export function withFileLink(result: ToolResult): ToolResult {
  if (result.isError || result.content.length !== 1) return result;
  const first = result.content[0]!;
  if (first.type !== "text") return result;
  const { enabled, denied } = effectivePackages();
  if (denied.includes("docs")) return result;
  const link = fileLinkOf(
    first.text,
    enabled.includes("docs") ? "docs" : "exports",
  );
  if (!link) return result;
  return { ...result, content: [first, link] };
}
