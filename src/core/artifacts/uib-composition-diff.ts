import { classifyProp, slotsOf } from "./uib-composition.js";

/**
 * N-31 (UX-21) — a per-element diff of two UI Builder macroponent
 * compositions (`sys_ux_macroponent.composition`), so snapshot / compare can
 * say "element X moved" or "prop Y of element X is now bound to @state.z"
 * instead of naming one opaque `composition` field.
 *
 * Elements are matched by `elementId`, never by position: an element that
 * changes parent, slot or order among its siblings is reported as `moved`,
 * never as removed + added. Within one slot, only the elements that leave the
 * longest common subsequence of the shared siblings count as moved, so one
 * insertion does not mark every later sibling.
 *
 * Pure, bounded and tolerant like the readers in ./uib-composition.ts: it
 * never throws and accepts whatever slot encoding `slotsOf` recognises. The
 * prop / binding shapes are verified:false until O-5 (a PDI).
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/** Elements read per side for the diff (the rest are counted). */
export const COMPOSITION_DIFF_MAX_ELEMENTS = 2000;

/** Slot nesting followed per side for the diff and the page metrics. */
export const COMPOSITION_DIFF_MAX_DEPTH = 50;

/** Element entries reported per diff (the rest are counted in `omitted`). */
export const COMPOSITION_DIFF_MAX_ENTRIES = 200;

/** One element of a flattened composition. */
export interface FlatElement {
  elementId: string;
  /** Parent elementId; `""` at the root. */
  parent: string;
  /** Slot name under the parent; `""` at the root. */
  slot: string;
  /** Position among the siblings of the same slot (0-based). */
  index: number;
  /** Nesting depth (root elements are 1). */
  depth: number;
  raw: Obj;
}

export interface FlatComposition {
  /** Elements by elementId, in document order. */
  elements: Map<string, FlatElement>;
  /** The elementIds of each slot, in order, keyed by {@link containerKey}. */
  containers: Map<string, string[]>;
  /** Deepest nesting seen (bounded by the depth cap). */
  maxDepth: number;
  /** Elements past the element or depth cap. */
  omitted: number;
  /** Elements whose elementId repeats an earlier one (the first wins). */
  duplicates: number;
}

const containerKey = (parent: string, slot: string): string =>
  `${parent}\u0000${slot}`;

const containerLabel = (parent: string, slot: string): string =>
  parent ? `${parent}/${slot}` : "(root)";

/** Count element-like objects below `items` (for `omitted`). */
function countAll(items: unknown[], depth = 0): number {
  if (depth > COMPOSITION_DIFF_MAX_DEPTH) return 0;
  let n = 0;
  for (const item of items) {
    if (!isObj(item) || typeof item.elementId !== "string") continue;
    n += 1;
    for (const [, sub] of slotsOf(item)) n += countAll(sub, depth + 1);
  }
  return n;
}

/**
 * Flatten a decoded composition into elements keyed by elementId with their
 * parent, slot, sibling index and depth. Anything that is not an array of
 * element objects flattens to nothing.
 */
export function flattenComposition(
  value: unknown,
  opts: { maxElements?: number; maxDepth?: number } = {},
): FlatComposition {
  const maxElements = opts.maxElements ?? COMPOSITION_DIFF_MAX_ELEMENTS;
  const maxDepth = opts.maxDepth ?? COMPOSITION_DIFF_MAX_DEPTH;
  const flat: FlatComposition = {
    elements: new Map(),
    containers: new Map(),
    maxDepth: 0,
    omitted: 0,
    duplicates: 0,
  };
  const walk = (
    items: unknown[],
    parent: string,
    slot: string,
    depth: number,
  ): void => {
    const ids: string[] = [];
    for (const item of items) {
      if (!isObj(item) || typeof item.elementId !== "string") continue;
      if (flat.elements.size >= maxElements) {
        flat.omitted += countAll([item]);
        continue;
      }
      const id = item.elementId;
      if (flat.elements.has(id)) {
        flat.duplicates += 1;
        continue;
      }
      flat.elements.set(id, {
        elementId: id,
        parent,
        slot,
        index: ids.length,
        depth,
        raw: item,
      });
      ids.push(id);
      flat.maxDepth = Math.max(flat.maxDepth, depth);
      for (const [name, sub] of slotsOf(item)) {
        if (depth + 1 > maxDepth) {
          flat.omitted += countAll(sub);
          continue;
        }
        walk(sub, id, name, depth + 1);
      }
    }
    if (ids.length) {
      const key = containerKey(parent, slot);
      flat.containers.set(key, [...(flat.containers.get(key) ?? []), ...ids]);
    }
  };
  if (Array.isArray(value)) walk(value, "", "", 1);
  return flat;
}

/** JSON with sorted object keys, for value comparison. */
function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((value as Obj)[k])}`)
    .join(",")}}`;
}

/** Keys of an element that hold structure or props, not attributes. */
const STRUCTURAL = new Set([
  "elementId",
  "slots",
  "children",
  "propertyValues",
  "props",
  "config",
  "overrides",
]);

/**
 * The raw props of one element by qualified name: `propertyValues` / `props`
 * entries by name, `config.<k>`, `overrides.<k>[.<p>]`, and a bound
 * `isHidden` (the same sources the N-26 explainer reads).
 */
export function elementProps(el: Obj): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const bag = isObj(el.propertyValues)
    ? el.propertyValues
    : isObj(el.props)
      ? el.props
      : undefined;
  if (bag) for (const [k, v] of Object.entries(bag)) out.set(k, v);
  if (isObj(el.config)) {
    for (const [k, v] of Object.entries(el.config)) out.set(`config.${k}`, v);
  }
  if (isObj(el.overrides)) {
    for (const [k, v] of Object.entries(el.overrides)) {
      const inner = isObj(v)
        ? isObj(v.propertyValues)
          ? v.propertyValues
          : isObj(v.props)
            ? v.props
            : undefined
        : undefined;
      if (inner) {
        for (const [p, pv] of Object.entries(inner)) {
          out.set(`overrides.${k}.${p}`, pv);
        }
      } else out.set(`overrides.${k}`, v);
    }
  }
  if (el.isHidden !== undefined && typeof el.isHidden !== "boolean") {
    out.set("isHidden", el.isHidden);
  }
  return out;
}

/** The binding expressions of one prop value, sorted. */
function bindingsOf(v: unknown): string {
  if (v === undefined) return "";
  return [...(classifyProp(v).bindings ?? [])].sort().join("\n");
}

/** One element that differs between the two compositions. */
export interface UibElementDiff {
  elementId: string;
  status: "added" | "removed" | "changed";
  /** `definition.id` (side b for added / changed, side a for removed). */
  component?: string;
  label?: string;
  /** changed: the element left its slot or its order among its siblings. */
  moved?: { from: string; to: string };
  /** changed: element attributes that differ (`definition`, `isHidden`, …). */
  attributes?: string[];
  /** changed: props whose literal value was added, removed or changed. */
  props?: string[];
  /** changed: props whose binding expressions changed. */
  bindings?: string[];
}

/** The element-level diff of two compositions (a → b). */
export interface CompositionDiff {
  added: number;
  removed: number;
  /** Elements whose position changed (also counted in `changed`). */
  moved: number;
  changed: number;
  /** At most COMPOSITION_DIFF_MAX_ENTRIES entries, ordered by elementId. */
  elements: UibElementDiff[];
  /** Entries past the cap. */
  omitted?: number;
  /** A side hit the element / depth cap or repeats an elementId: partial. */
  truncated?: true;
}

/** Longest common subsequence membership of `a` against `b`. */
function lcsSet(a: readonly string[], b: readonly string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

/** Elements reordered inside a slot they keep on both sides. */
function reordered(a: FlatComposition, b: FlatComposition): Set<string> {
  const out = new Set<string>();
  for (const [key, idsA] of a.containers) {
    const idsB = b.containers.get(key);
    if (!idsB) continue;
    const inB = new Set(idsB);
    const inA = new Set(idsA);
    const commonA = idsA.filter((id) => inB.has(id));
    const commonB = idsB.filter((id) => inA.has(id));
    if (commonA.join("\u0000") === commonB.join("\u0000")) continue;
    const keep = lcsSet(commonA, commonB);
    for (const id of commonA) if (!keep.has(id)) out.add(id);
  }
  return out;
}

function describe(
  el: FlatElement,
): Pick<UibElementDiff, "component" | "label"> {
  const def = isObj(el.raw.definition) ? el.raw.definition : {};
  const component = text(def.id);
  const label = text(el.raw.elementLabel) ?? text(el.raw.label);
  return {
    ...(component ? { component } : {}),
    ...(label ? { label } : {}),
  };
}

const position = (el: FlatElement): string =>
  `${containerLabel(el.parent, el.slot)}#${el.index}`;

/** Compare one element present on both sides; undefined when equal. */
function diffElement(
  x: FlatElement,
  y: FlatElement,
  moved: boolean,
): UibElementDiff | undefined {
  const attributes = [
    ...new Set([...Object.keys(x.raw), ...Object.keys(y.raw)]),
  ]
    .filter((k) => !STRUCTURAL.has(k))
    .filter((k) => !(k === "isHidden" && isBound(x.raw, y.raw)))
    .filter((k) => stable(x.raw[k]) !== stable(y.raw[k]))
    .sort();
  const pa = elementProps(x.raw);
  const pb = elementProps(y.raw);
  const props: string[] = [];
  const bindings: string[] = [];
  for (const name of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
    const va = pa.get(name);
    const vb = pb.get(name);
    if (stable(va) === stable(vb)) continue;
    if (bindingsOf(va) !== bindingsOf(vb)) bindings.push(name);
    else props.push(name);
  }
  if (!moved && !attributes.length && !props.length && !bindings.length) {
    return undefined;
  }
  return {
    elementId: y.elementId,
    status: "changed",
    ...describe(y),
    ...(moved ? { moved: { from: position(x), to: position(y) } } : {}),
    ...(attributes.length ? { attributes } : {}),
    ...(props.length ? { props } : {}),
    ...(bindings.length ? { bindings } : {}),
  };
}

/** A non-boolean `isHidden` on either side is a prop, not an attribute. */
function isBound(a: Obj, b: Obj): boolean {
  return (
    (a.isHidden !== undefined && typeof a.isHidden !== "boolean") ||
    (b.isHidden !== undefined && typeof b.isHidden !== "boolean")
  );
}

/**
 * The element-level diff of two decoded compositions (a → b). Diffing a
 * composition against itself is empty; a moved element is one `changed`
 * entry with `moved`, never a removal plus an addition.
 */
export function compositionDiff(a: unknown, b: unknown): CompositionDiff {
  const fa = flattenComposition(a);
  const fb = flattenComposition(b);
  const reorder = reordered(fa, fb);
  const entries: UibElementDiff[] = [];
  let added = 0;
  let removed = 0;
  let moved = 0;
  let changed = 0;
  for (const [id, x] of fa.elements) {
    const y = fb.elements.get(id);
    if (!y) {
      removed++;
      entries.push({ elementId: id, status: "removed", ...describe(x) });
      continue;
    }
    const isMoved =
      x.parent !== y.parent || x.slot !== y.slot || reorder.has(id);
    const d = diffElement(x, y, isMoved);
    if (d) {
      changed++;
      if (isMoved) moved++;
      entries.push(d);
    }
  }
  for (const [id, y] of fb.elements) {
    if (fa.elements.has(id)) continue;
    added++;
    entries.push({ elementId: id, status: "added", ...describe(y) });
  }
  entries.sort((p, q) =>
    p.elementId < q.elementId ? -1 : p.elementId > q.elementId ? 1 : 0,
  );
  const omitted = Math.max(0, entries.length - COMPOSITION_DIFF_MAX_ENTRIES);
  const partial = fa.omitted + fb.omitted + fa.duplicates + fb.duplicates > 0;
  return {
    added,
    removed,
    moved,
    changed,
    elements: entries.slice(0, COMPOSITION_DIFF_MAX_ENTRIES),
    ...(omitted ? { omitted } : {}),
    ...(partial ? { truncated: true as const } : {}),
  };
}

/** Whether a diff found nothing. */
export function isEmptyCompositionDiff(d: CompositionDiff): boolean {
  return d.added + d.removed + d.changed === 0;
}

/** A one-line summary: `+1 -2 ~3 (moved 1)`. */
export function compositionDiffSummary(d: CompositionDiff): string {
  return `+${d.added} -${d.removed} ~${d.changed}${d.moved ? ` (moved ${d.moved})` : ""}${d.truncated ? " partial" : ""}`;
}
