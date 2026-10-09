import type { ProgressTracker } from "../core/progress.js";
import { CHILD_LIMIT } from "./artifacts.js";
import { degradeStatus, IN_CHUNK } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * Bounded reads (the P-16 pattern) shared by the explainers that walk an
 * artefact tree over unverified tables: ui-experience, portal, explain-flow.
 */

/** A record id safe to splice into an encoded query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A table the walk could not read, and why. */
export interface Unreadable {
  table: string;
  status?: number;
  reason: string;
}

/** Read state shared by every step: caveats, progress and field checks. */
export interface ReadCtx {
  caveats: string[];
  unreadable: Unreadable[];
  missing: Record<string, string[]>;
  progress: ProgressTracker;
  /** What a cap or an unreadable table leaves incomplete, e.g. "the tree"; default "the result". */
  scope?: string;
}

/** Record the requested fields that no returned row carries. */
export function noteMissing(
  ctx: ReadCtx,
  table: string,
  fields: string[],
  rows: SnRecord[],
): void {
  if (!rows.length) return;
  const missing = fields.filter((f) => rows.every((r) => !(f in r)));
  if (!missing.length) return;
  const seen = new Set(ctx.missing[table] ?? []);
  for (const f of missing) seen.add(f);
  ctx.missing[table] = [...seen];
}

/**
 * One bounded read. A degradable instance error (400 / 403 / 404, which
 * includes a policy denial) is recorded as a caveat and yields no rows; a
 * table recorded as unreadable is not read again.
 */
export async function boundedRead(
  ctx: ReadCtx,
  table: string,
  query: string,
  fields: string[],
  limit = CHILD_LIMIT,
): Promise<SnRecord[]> {
  ctx.progress.tick(table);
  if (ctx.unreadable.some((u) => u.table === table)) return [];
  try {
    const { records, total } = await queryTable({
      table,
      query,
      fields,
      limit,
      displayValue: "false",
    });
    if (
      limit === CHILD_LIMIT &&
      records.length >= limit &&
      (total === undefined || total > records.length)
    ) {
      ctx.caveats.push(
        `${table}: read capped at ${CHILD_LIMIT} rows; ${ctx.scope ?? "the result"} may be incomplete.`,
      );
    }
    noteMissing(ctx, table, fields, records);
    return records;
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    const reason = (error as Error).message;
    ctx.unreadable.push({ table, status, reason });
    ctx.caveats.push(
      `${table} could not be read (${status}): ${reason} That part${ctx.scope ? ` of ${ctx.scope}` : ""} is omitted.`,
    );
    return [];
  }
}

/**
 * `prefix^fieldIN ids suffix ^ORDERBY order` over chunks of `IN_CHUNK`,
 * capped at `CHILD_LIMIT` rows. Ids that are not SAFE_ID (a malformed
 * reference) are dropped.
 */
export async function boundedReadIn(
  ctx: ReadCtx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  opts: { prefix?: string; suffix?: string; order?: string } = {},
): Promise<SnRecord[]> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: SnRecord[] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    const query = `${opts.prefix ? `${opts.prefix}^` : ""}${field}IN${chunk.join(",")}${
      opts.suffix ?? ""
    }${opts.order ? `^ORDERBY${opts.order}` : ""}`;
    out.push(...(await boundedRead(ctx, table, query, fields)));
    if (out.length >= CHILD_LIMIT) {
      if (i + IN_CHUNK < list.length) {
        ctx.caveats.push(
          `${table}: stopped after ${out.length} rows; ${ctx.scope ?? "the result"} may be incomplete.`,
        );
      }
      break;
    }
  }
  return out;
}
