import { promises as fs } from "node:fs";
import path from "node:path";
import { getDocsDir, getDocsMaxFileBytes } from "../core/settings.js";
import { isGenerated, isPlainObject } from "./docs-frontmatter.js";
import { INDEX_FILE, walk } from "./docs-paths.js";
import { inspect } from "./docs-inspect.js";

/**
 * Docs store manifest: index.json and the index.md rendered from it.
 */

export const MANIFEST_FILE = "index.json";

/** One document in index.json. */
export interface ManifestEntry {
  path: string;
  kind: string | null;
  title: string | null;
  profile: string | null;
  generator: string | null;
  generated_at: string | null;
  source_hash: string | null;
  bytes: number;
  headings: string[];
  /** Present when the document records an interrupted run. */
  partial?: true;
  /** The sibling generated `.json` companion of a Markdown entry (ID-21). */
  companion?: string;
}

/** The last run of one generator, as recorded in index.json (ID-19). */
export interface ManifestRun {
  profile: string;
  started_at: string;
  /** `null` while the run is open. */
  finished_at: string | null;
  /** True while the run is open, and after an interrupted run. */
  partial: boolean;
  /** Files the run wrote. */
  files: number;
}

/** A change to the recorded runs, applied inside the serialized rebuild. */
type RunsUpdate = (runs: Record<string, ManifestRun>) => void;

/**
 * index.md / index.json regeneration is serialized through this tail
 * promise: concurrent docsWriteRaw() calls (pipelined requests, or two
 * profiles snapshotting at once) must not interleave a walk() with another
 * call's write, or the rebuilt index would drop the entries written in
 * between. The tail keeps the chain alive across a failed rebuild so a later
 * call is not stuck behind it.
 */
let indexTail: Promise<unknown> = Promise.resolve();

/** Rebuild the manifest and the index.md rendered from it. */
export function regenerateIndex(update?: RunsUpdate): Promise<void> {
  const rebuild = () => rebuildIndex(update);
  const run = indexTail.then(rebuild, rebuild);
  indexTail = run.catch(() => {});
  return run;
}

/** The `runs` recorded in the current index.json (ID-19), or none. */
async function readRuns(root: string): Promise<Record<string, ManifestRun>> {
  try {
    const raw = await fs.readFile(path.join(root, MANIFEST_FILE), "utf8");
    const runs = (JSON.parse(raw) as { runs?: unknown }).runs;
    return isPlainObject(runs) ? (runs as Record<string, ManifestRun>) : {};
  } catch {
    return {};
  }
}

async function rebuildIndex(update?: RunsUpdate): Promise<void> {
  const root = getDocsDir();
  const all: string[] = [];
  // ID-21: generated `.json` companions are listed too; other JSON files
  // (exports) and the manifest itself are not.
  await walk(root, root, all, [".md", ".json"]);
  const docs = all
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower !== INDEX_FILE && lower !== MANIFEST_FILE;
    })
    .sort();
  const max = getDocsMaxFileBytes();
  const files: ManifestEntry[] = [];
  for (const file of docs) {
    const info = await inspect(path.join(root, file), max);
    if (!info) continue;
    const f = isGenerated(info.fields) ? info.fields : undefined;
    if (file.toLowerCase().endsWith(".json")) {
      if (!f) continue;
      files.push({
        path: file,
        kind: f.sn_kind ?? null,
        title: null,
        profile: f.sn_profile ?? null,
        generator: f.sn_generator ?? null,
        generated_at: f.sn_generated_at ?? null,
        source_hash: f.sn_source_hash ?? null,
        bytes: info.bytes,
        headings: [],
        ...(f.sn_partial === "true" ? { partial: true as const } : {}),
      });
      continue;
    }
    files.push({
      path: file,
      kind: f ? (f.sn_kind ?? "generated") : null,
      title: info.title ?? null,
      profile: f?.sn_profile ?? null,
      generator: f?.sn_generator ?? null,
      generated_at: f?.sn_generated_at ?? null,
      source_hash: f?.sn_source_hash ?? null,
      bytes: info.bytes,
      headings: info.headings,
      ...(f?.sn_partial === "true" ? { partial: true as const } : {}),
    });
  }
  const jsonPaths = new Set(
    files.filter((e) => e.path.endsWith(".json")).map((e) => e.path),
  );
  for (const e of files) {
    const sibling = e.path.replace(/\.md$/i, ".json");
    if (sibling !== e.path && jsonPaths.has(sibling)) e.companion = sibling;
  }
  const runs = await readRuns(root);
  update?.(runs);
  const partial = files.some((e) => e.partial);
  await fs.writeFile(
    path.join(root, MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        ...(partial ? { partial } : {}),
        ...(Object.keys(runs).length > 0 ? { runs } : {}),
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, INDEX_FILE),
    renderIndex(files, runs),
    "utf8",
  );
}

/**
 * Open a multi-file generator run (ID-19): recorded in index.json `runs` as
 * `{ partial: true, finished_at: null }` until docsRunEnd closes it, so a
 * reader can tell an open or cancelled run from a finished one.
 */
export function docsRunBegin(
  generator: string,
  profile: string,
  startedAt = new Date().toISOString(),
): Promise<void> {
  return regenerateIndex((runs) => {
    runs[generator] = {
      profile,
      started_at: startedAt,
      finished_at: null,
      partial: true,
      files: 0,
    };
  });
}

/** Close a run opened by docsRunBegin; `partial` marks an interrupted run. */
export function docsRunEnd(
  generator: string,
  profile: string,
  result: { files: number; partial?: boolean },
): Promise<void> {
  return regenerateIndex((runs) => {
    const now = new Date().toISOString();
    runs[generator] = {
      profile,
      started_at: runs[generator]?.started_at ?? now,
      finished_at: now,
      partial: result.partial === true,
      files: result.files,
    };
  });
}

/**
 * M-4 (ID-13): the manifest's entries as last written, or `undefined` when
 * the store has no (readable) index.json yet. Read-only; never rebuilds.
 */
export async function docsManifest(): Promise<ManifestEntry[] | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(getDocsDir(), MANIFEST_FILE),
      "utf8",
    );
    const files = (JSON.parse(raw) as { files?: unknown }).files;
    return Array.isArray(files)
      ? (files as ManifestEntry[]).filter((e) => typeof e?.path === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * index.md: open or interrupted runs first (ID-19), then generated documents
 * by profile and kind; hand-written last. JSON companions are reached through
 * their Markdown entry.
 */
function renderIndex(
  entries: ManifestEntry[],
  runs: Record<string, ManifestRun> = {},
): string {
  const files = entries.filter((e) => !e.path.toLowerCase().endsWith(".json"));
  const link = (e: ManifestEntry): string =>
    `- [${e.path}](${e.path})${e.title ? ` — ${e.title}` : ""}`;
  const lines = [
    "# ServiceNow instance documentation",
    "",
    "Auto-generated index of documents in this folder.",
    "",
  ];
  const unfinished = Object.entries(runs)
    .filter(([, r]) => r.partial)
    .sort(([a], [b]) => a.localeCompare(b));
  if (unfinished.length > 0) {
    lines.push("## Unfinished runs", "");
    for (const [generator, r] of unfinished) {
      lines.push(
        r.finished_at === null
          ? `- ${generator} on \`${r.profile}\` — open, started ${r.started_at}`
          : `- ${generator} on \`${r.profile}\` — partial, ${r.files} files, interrupted ${r.finished_at}`,
      );
    }
    lines.push("");
  }
  const generated = files.filter((e) => e.generator !== null);
  const profiles = [...new Set(generated.map((e) => e.profile ?? ""))].sort();
  for (const profile of profiles) {
    lines.push(profile ? `## Profile \`${profile}\`` : "## No profile", "");
    const inProfile = generated.filter((e) => (e.profile ?? "") === profile);
    const kinds = [...new Set(inProfile.map((e) => e.kind ?? ""))].sort();
    for (const kind of kinds) {
      lines.push(`### ${kind}`, "");
      for (const e of inProfile.filter((x) => (x.kind ?? "") === kind)) {
        lines.push(link(e));
      }
      lines.push("");
    }
  }
  const manual = files.filter((e) => e.generator === null);
  if (manual.length > 0) {
    if (generated.length > 0) lines.push("## Hand-written", "");
    for (const e of manual) lines.push(link(e));
    lines.push("");
  }
  return lines.join("\n");
}
