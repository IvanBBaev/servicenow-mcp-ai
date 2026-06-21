import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getDocsDir } from "./settings.js";
import { activeProfile } from "./config.js";
import { logger } from "./logging.js";

/**
 * DF-2 — local, append-only audit trail for every applied write.
 *
 * The official MCP Server Console has AI Control Tower for audit and metering;
 * this client-side server has no such backstop, so every mutation it actually
 * executes is journalled locally under the docs directory, per profile. The
 * journal is written best-effort: a file-system failure is logged but never
 * blocks or fails the write that already happened on the instance.
 */

export type WriteAction = "create" | "update" | "delete";

export interface JournalEntry {
  ts: string;
  profile: string;
  action: WriteAction;
  table: string;
  sys_id?: string;
  /** The field values sent (create/update); omitted for delete. */
  fields?: Record<string, unknown>;
}

function formatMarkdownRow(e: JournalEntry): string {
  const target = e.sys_id ? `${e.table}/${e.sys_id}` : e.table;
  const fields = e.fields ? Object.keys(e.fields).join(", ") : "—";
  return `| ${e.ts} | ${e.action} | ${target} | ${fields} |\n`;
}

/**
 * Append one applied mutation to `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}`.
 * Returns the full entry (with timestamp + profile) so the tool can echo when it
 * was journalled. Never throws — journalling must not turn a successful write
 * into a tool error.
 */
export function appendWriteJournal(
  entry: Omit<JournalEntry, "ts" | "profile">,
): JournalEntry {
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    profile: activeProfile(),
    ...entry,
  };
  try {
    const dir = path.join(getDocsDir(), full.profile);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "write-journal.jsonl"),
      JSON.stringify(full) + "\n",
    );
    appendFileSync(path.join(dir, "write-journal.md"), formatMarkdownRow(full));
  } catch (error) {
    logger.warn("write-journal append failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return full;
}
