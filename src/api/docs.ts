import { promises as fs } from "node:fs";
import path from "node:path";
import { ServiceNowError } from "../errors.js";
import { getDocsDir } from "../settings.js";

/**
 * Local self-documentation store. These tools read and write Markdown files in
 * a single directory (SN_DOCS_DIR, default `docs/instance/`) so the model can
 * accumulate durable knowledge about an instance across sessions. They touch
 * the local filesystem only — never ServiceNow — and are strictly confined to
 * the docs directory to prevent path traversal.
 */

const INDEX_FILE = "index.md";

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

/** Resolve a docs-relative path to an absolute one, rejecting any escape. */
function resolveDocPath(relPath: string): string {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ServiceNowError("A document path is required.", 400);
  }
  // Strip leading slashes/backslashes so the path is always treated as relative.
  const cleaned = relPath.trim().replace(/^[/\\]+/, "");
  const root = getDocsDir();
  const resolved = path.resolve(root, cleaned);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ServiceNowError(
      `Path escapes the docs directory: ${relPath}`,
      400,
    );
  }
  if (path.extname(resolved).toLowerCase() !== ".md") {
    throw new ServiceNowError("Only .md files are supported.", 400);
  }
  return resolved;
}

/** Recursively collect Markdown files under `dir`, as posix-style relative paths. */
async function walk(dir: string, root: string, out: string[]): Promise<void> {
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
      await walk(full, root, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

/** List every Markdown document under the docs directory. */
export async function docsList(): Promise<{
  dir: string;
  count: number;
  files: string[];
}> {
  const root = getDocsDir();
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  return { dir: root, count: files.length, files };
}

/** Read one Markdown document's full content. */
export async function docsRead(
  relPath: string,
): Promise<{ path: string; content: string }> {
  const abs = resolveDocPath(relPath);
  try {
    const content = await fs.readFile(abs, "utf8");
    return { path: relPath, content };
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      throw new ServiceNowError(`Document not found: ${relPath}`, 404);
    }
    throw e;
  }
}

export interface DocMatch {
  path: string;
  line: number;
  snippet: string;
}

/** Search the docs for a literal substring, returning a snippet per match. */
export async function docsSearch(
  text: string,
): Promise<{ count: number; matches: DocMatch[] }> {
  const needle = text?.trim();
  if (!needle) {
    throw new ServiceNowError("docsSearch requires a non-empty 'text'.", 400);
  }
  const lower = needle.toLowerCase();
  const { files } = await docsList();
  const matches: DocMatch[] = [];
  for (const file of files) {
    const content = await fs.readFile(resolveDocPath(file), "utf8");
    const lines = content.split("\n");
    for (const [i, line] of lines.entries()) {
      if (line.toLowerCase().includes(lower)) {
        matches.push({ path: file, line: i + 1, snippet: line.trim().slice(0, 200) });
      }
    }
  }
  return { count: matches.length, matches };
}

/** Rebuild index.md as a table of contents linking every other document. */
async function regenerateIndex(): Promise<void> {
  const root = getDocsDir();
  const all: string[] = [];
  await walk(root, root, all);
  const docs = all
    .filter((f) => f.toLowerCase() !== INDEX_FILE)
    .sort();
  const lines = [
    "# ServiceNow instance documentation",
    "",
    "Auto-generated index of documents in this folder.",
    "",
    ...docs.map((f) => `- [${f}](${f})`),
    "",
  ];
  await fs.writeFile(path.join(root, INDEX_FILE), lines.join("\n"), "utf8");
}

/**
 * Create or overwrite a Markdown document, then regenerate index.md. Writing
 * index.md directly is allowed; it is rebuilt afterwards either way.
 */
export async function docsWrite(
  relPath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const abs = resolveDocPath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  await regenerateIndex();
  return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
}
