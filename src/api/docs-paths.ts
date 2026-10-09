import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { activeProfile, listProfiles } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { getDocsDir } from "../core/settings.js";

/**
 * Docs store paths: the SN_DOCS_DIR confinement checks, the directory walk,
 * the size guard and the S-14 profile scoping.
 */

export const INDEX_FILE = "index.md";

export function errorCode(e: unknown): string | undefined {
  return typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof e.code === "string"
    ? e.code
    : undefined;
}

/**
 * H-5 — the lexical check cannot see symlinks: a link inside the docs
 * directory (e.g. `docs/instance/out -> /etc`) would let a write land outside
 * it. Resolve the nearest existing ancestor of the target through the file
 * system and require it to stay inside the real docs root.
 */
export function assertRealPathInside(
  root: string,
  target: string,
  relPath: string,
) {
  if (!existsSync(root)) return; // nothing under a missing root can be a link
  let probe = target;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const rel = path.relative(realpathSync(root), realpathSync(probe));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ServiceNowError(
      `Path escapes the docs directory through a symbolic link: ${relPath}`,
      400,
    );
  }
}

/**
 * Windows device names are special in every directory (`con.md` opens the
 * console), with or without an extension (H-6 / GAP L2-10).
 */
const RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Refuse path segments that behave differently on another platform: Windows
 * reserved device names and any `:` (an NTFS alternate data stream such as
 * `a.md:hidden`, or a drive prefix).
 */
function assertPortableSegments(relPath: string, cleaned: string): void {
  for (const segment of cleaned.split(/[/\\]/)) {
    if (segment.includes(":")) {
      throw new ServiceNowError(
        `Document path may not contain ":" (drive prefix or alternate data stream): ${relPath}`,
        400,
      );
    }
    if (RESERVED_SEGMENT_RE.test(segment)) {
      throw new ServiceNowError(
        `Document path uses a reserved Windows device name ("${segment}"): ${relPath}`,
        400,
      );
    }
  }
}

/** Resolve a docs-relative path to an absolute one, rejecting any escape. */
export function resolveDocPath(relPath: string, extensions = [".md"]): string {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ServiceNowError("A document path is required.", 400);
  }
  // Strip leading slashes/backslashes so the path is always treated as relative.
  const cleaned = relPath.trim().replace(/^[/\\]+/, "");
  assertPortableSegments(relPath, cleaned);
  const root = getDocsDir();
  const resolved = path.resolve(root, cleaned);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ServiceNowError(
      `Path escapes the docs directory: ${relPath}`,
      400,
    );
  }
  if (!extensions.includes(path.extname(resolved).toLowerCase())) {
    throw new ServiceNowError(
      `Only ${extensions.join("/")} files are supported.`,
      400,
    );
  }
  assertRealPathInside(root, resolved, relPath);
  return resolved;
}

/** The write journal's own files — never writable through the docs store. */
export const JOURNAL_FILE = /^write-journal\./i;

/** A size-cap error for a document (SN_DOCS_MAX_FILE_BYTES). */
export function tooLarge(
  relPath: string,
  bytes: number,
  max: number,
): ServiceNowError {
  return new ServiceNowError(
    `Document ${relPath} is ${bytes} bytes, over the SN_DOCS_MAX_FILE_BYTES limit of ${max}.`,
    413,
    undefined,
    {
      code: "PAYLOAD_TOO_LARGE",
      hint: "Split the document into smaller files or raise SN_DOCS_MAX_FILE_BYTES.",
    },
  );
}

/**
 * Recursively collect the files under `dir` whose extension is in
 * `extensions` (Markdown by default), as posix-style relative paths.
 */
export async function walk(
  dir: string,
  root: string,
  out: string[],
  extensions: readonly string[] = [".md"],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errorCode(e) === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out, extensions);
    } else if (
      entry.isFile() &&
      extensions.includes(path.extname(entry.name).toLowerCase())
    ) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

/**
 * Resolve a docs `profile` argument: `current` is the active profile, any
 * other value must name a configured profile.
 */
export function resolveDocsProfile(profile: string): string {
  const name = String(profile).trim().toLowerCase();
  if (name === "current") return activeProfile();
  const known = new Set([activeProfile(), ...listProfiles()]);
  if (!known.has(name)) {
    throw new ServiceNowError(
      `Unknown profile "${profile}" — use "current" or one of: ${[...known].join(", ")}.`,
      400,
    );
  }
  return name;
}

/** A docs path, prefixed with `<profile>/` when a profile is given. */
export function scoped(relPath: string, profile?: string): string {
  if (profile === undefined) return relPath;
  const p = resolveDocsProfile(profile);
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ServiceNowError("A document path is required.", 400);
  }
  return `${p}/${relPath.trim().replace(/^[/\\]+/, "")}`;
}
