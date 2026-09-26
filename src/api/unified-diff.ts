/**
 * S-7 — a line-based unified diff (Myers, O((N+M)·D)) for the drift report:
 * compare_instances shows *how* a script differs, not only that its hash
 * does. Output follows `diff -u` (`@@ -a,n +b,m @@` hunks with three lines of
 * context) so any Markdown renderer highlights it as a `diff` block.
 */

type Op = [" " | "-" | "+", string];

/** Edit distance above which the diff gives up (keeps memory at O(D²)). */
const MAX_EDITS = 4000;
const CONTEXT = 3;

/** Myers' shortest edit script, or undefined past MAX_EDITS. */
function editScript(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  // v[k] = furthest x on diagonal k; trace[d] keeps the v of k ∈ [-d-1, d+1]
  // before round d, which is all the backtrack reads.
  let v = new Int32Array(3);
  const trace: Int32Array[] = [];
  const at = (arr: Int32Array, d: number, k: number): number => arr[k + d + 1]!;
  for (let d = 0; d <= limit; d++) {
    trace.push(v);
    const next = new Int32Array(2 * d + 5);
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && at(v, d, k - 1) < at(v, d, k + 1))
          ? at(v, d, k + 1)
          : at(v, d, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k + d + 2] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
    v = next;
  }
  return undefined;
}

function backtrack(
  a: string[],
  b: string[],
  trace: Int32Array[],
  depth: number,
): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d]!;
    const get = (k: number): number => v[k + d + 1]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([" ", a[--x]!]);
      y--;
    }
    if (x === prevX) ops.push(["+", b[--y]!]);
    else ops.push(["-", a[--x]!]);
  }
  while (x > 0) ops.push([" ", a[--x]!]);
  return ops.reverse();
}

/**
 * Unified diff of two texts, capped at `maxLines` output lines (a final
 * `… N more line(s)` marks the cut). Identical texts give "".
 */
export function unifiedDiff(
  aText: string,
  bText: string,
  labelA: string,
  labelB: string,
  maxLines = 200,
): string {
  if (aText === bText) return "";
  const a = aText.split(/\r?\n/);
  const b = bText.split(/\r?\n/);
  const ops = editScript(a, b);
  const head = [`--- ${labelA}`, `+++ ${labelB}`];
  if (!ops) {
    return [
      ...head,
      `(too many changes to diff: ${a.length} vs ${b.length} lines)`,
    ].join("\n");
  }
  const lines = [...head];
  // Group changes into hunks that share context.
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]![0] === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    while (end < ops.length) {
      if (ops[end]![0] !== " ") {
        end++;
        continue;
      }
      let run = end;
      while (run < ops.length && ops[run]![0] === " ") run++;
      if (run >= ops.length || run - end > 2 * CONTEXT) {
        end = Math.min(run, end + CONTEXT);
        break;
      }
      end = run;
    }
    // Line numbers of the hunk start on each side.
    let lineA = 1;
    let lineB = 1;
    for (const [op] of ops.slice(0, start)) {
      if (op !== "+") lineA++;
      if (op !== "-") lineB++;
    }
    const hunk = ops.slice(start, end);
    const countA = hunk.filter(([op]) => op !== "+").length;
    const countB = hunk.filter(([op]) => op !== "-").length;
    lines.push(
      `@@ -${countA ? lineA : lineA - 1},${countA} +${countB ? lineB : lineB - 1},${countB} @@`,
      ...hunk.map(([op, text]) => `${op}${text}`),
    );
    i = end;
  }
  if (lines.length > maxLines) {
    const more = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `… ${more} more line(s)`].join("\n");
  }
  return lines.join("\n");
}
