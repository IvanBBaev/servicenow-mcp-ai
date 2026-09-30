/**
 * P-14 — reading UI Builder macroponent JSON (project/SDK-PARITY.md §4 P-14).
 *
 * `sys_ux_macroponent` stores a page as schemaless JSON columns:
 *
 * - `composition` — the component tree: an array of elements, each with an
 *   `elementId`, a `definition` (`{id, type}`, the component or macroponent it
 *   renders) and nested elements under `slots` / `children`;
 * - `data` — data resources: elements whose `definition.id` names a data
 *   broker record;
 * - `state_properties` — client state (`[{name, valueType, initialValue}]`);
 * - `internal_event_mappings` — event wiring (source element + event →
 *   handlers).
 *
 * None of these shapes is documented, and they differ between releases, so
 * every reader here is tolerant: it takes what it recognises, counts what it
 * skips, and never throws. The `uib-composition` decoder only accepts a value
 * that looks like a composition (an array of objects with an `elementId`); any
 * other shape comes back raw with `decoded:false`. All shapes are unverified
 * until gate O-5 (a PDI) confirms them.
 */

/** Elements walked per composition (the rest are counted, not listed). */
export const COMPOSITION_MAX_ELEMENTS = 500;

/** Slot nesting followed per composition. */
export const COMPOSITION_MAX_DEPTH = 12;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/** One element of the component tree. */
export interface UibElement {
  elementId: string;
  /** `definition.id` — the component / macroponent sys_id or tag. */
  component?: string;
  /** `definition.type` (e.g. MACROPONENT, COMPONENT). */
  type?: string;
  label?: string;
  hidden?: true;
  slots: { name: string; elements: UibElement[] }[];
}

export interface CompositionTree {
  elements: UibElement[];
  /** Elements walked. */
  count: number;
  /** Elements not walked (element cap or depth cap). */
  omitted: number;
  /** Items skipped because they were not element objects. */
  skipped: number;
}

/** Whether a decoded value has the shape of a composition. */
export function isComposition(value: unknown): value is Obj[] {
  return (
    Array.isArray(value) &&
    value.every((e) => isObj(e) && typeof e.elementId === "string")
  );
}

/** The `[name, items]` slot pairs of one element, whatever the encoding. */
function slotsOf(el: Obj): [string, unknown[]][] {
  const out: [string, unknown[]][] = [];
  const slots = el.slots;
  if (Array.isArray(slots)) {
    slots.forEach((s, i) => {
      if (!isObj(s)) return;
      const name = text(s.slotName) ?? text(s.name) ?? `slot${i + 1}`;
      const items = Array.isArray(s.children)
        ? s.children
        : Array.isArray(s.elements)
          ? s.elements
          : [];
      out.push([name, items]);
    });
  } else if (isObj(slots)) {
    for (const [name, items] of Object.entries(slots)) {
      if (Array.isArray(items)) out.push([name, items]);
      else if (isObj(items) && Array.isArray(items.children)) {
        out.push([name, items.children]);
      }
    }
  }
  if (Array.isArray(el.children)) out.push(["default", el.children]);
  return out;
}

/** Count every element-like object below `items` (for `omitted`). */
function countAll(items: unknown[], depth = 0): number {
  if (depth > 50) return 0;
  let n = 0;
  for (const item of items) {
    if (!isObj(item) || typeof item.elementId !== "string") continue;
    n += 1;
    for (const [, sub] of slotsOf(item)) n += countAll(sub, depth + 1);
  }
  return n;
}

/**
 * The component tree of a decoded `composition`, bounded by
 * COMPOSITION_MAX_ELEMENTS and COMPOSITION_MAX_DEPTH.
 */
export function compositionTree(value: unknown): CompositionTree {
  const tree: CompositionTree = {
    elements: [],
    count: 0,
    omitted: 0,
    skipped: 0,
  };
  const walk = (items: unknown[], depth: number): UibElement[] => {
    const out: UibElement[] = [];
    for (const item of items) {
      if (!isObj(item) || typeof item.elementId !== "string") {
        tree.skipped += 1;
        continue;
      }
      if (tree.count >= COMPOSITION_MAX_ELEMENTS) {
        tree.omitted += countAll([item]);
        continue;
      }
      tree.count += 1;
      const def = isObj(item.definition) ? item.definition : {};
      const el: UibElement = {
        elementId: item.elementId,
        ...(text(def.id) ? { component: text(def.id) } : {}),
        ...(text(def.type) ? { type: text(def.type) } : {}),
        ...(text(item.elementLabel) || text(item.label)
          ? { label: text(item.elementLabel) ?? text(item.label) }
          : {}),
        ...(item.isHidden === true ? { hidden: true as const } : {}),
        slots: [],
      };
      for (const [name, sub] of slotsOf(item)) {
        if (depth + 1 >= COMPOSITION_MAX_DEPTH) {
          tree.omitted += countAll(sub);
          continue;
        }
        const elements = walk(sub, depth + 1);
        if (elements.length) el.slots.push({ name, elements });
      }
      out.push(el);
    }
    return out;
  };
  if (Array.isArray(value)) tree.elements = walk(value, 0);
  return tree;
}

/** One data resource of a macroponent (`data`). */
export interface UibDataResource {
  elementId: string;
  label?: string;
  /** `definition.id` — the data broker sys_id (or a built-in broker id). */
  broker?: string;
  /** `definition.type` (e.g. TRANSFORM, SCRIPTLET, GRAPHQL). */
  type?: string;
}

/** The data resources of a decoded `data` value; `null` for an unknown shape. */
export function dataResources(value: unknown): UibDataResource[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: UibDataResource[] = [];
  for (const item of value) {
    if (!isObj(item) || typeof item.elementId !== "string") continue;
    const def = isObj(item.definition) ? item.definition : {};
    out.push({
      elementId: item.elementId,
      ...(text(item.elementLabel) || text(item.label)
        ? { label: text(item.elementLabel) ?? text(item.label) }
        : {}),
      ...(text(def.id) ? { broker: text(def.id) } : {}),
      ...(text(def.type) ? { type: text(def.type) } : {}),
    });
    if (out.length >= COMPOSITION_MAX_ELEMENTS) break;
  }
  return out;
}

/** One client state property (`state_properties`). */
export interface UibStateProperty {
  name: string;
  type?: string;
  /** Whether an initial value is set. */
  initial?: true;
}

/** The client state of a decoded `state_properties`; `null` when unknown. */
export function stateProperties(value: unknown): UibStateProperty[] | null {
  if (value === null || value === undefined) return [];
  const entries: [string, Obj][] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isObj(item) && text(item.name))
        entries.push([item.name as string, item]);
    }
  } else if (isObj(value)) {
    for (const [name, item] of Object.entries(value)) {
      entries.push([name, isObj(item) ? item : {}]);
    }
  } else {
    return null;
  }
  return entries.slice(0, COMPOSITION_MAX_ELEMENTS).map(([name, item]) => ({
    name,
    ...(text(item.valueType) || text(item.type)
      ? { type: text(item.valueType) ?? text(item.type) }
      : {}),
    ...(item.initialValue !== undefined && item.initialValue !== null
      ? { initial: true as const }
      : {}),
  }));
}

/** One wired event: a source (element or `element.event`) → handlers. */
export interface UibEventWiring {
  source: string;
  event?: string;
  handlers: string[];
}

/** A short name for one handler entry. */
function handlerName(h: unknown): string | undefined {
  if (typeof h === "string") return h || undefined;
  if (!isObj(h)) return undefined;
  const def = isObj(h.definition) ? h.definition : {};
  return (
    text(def.id) ??
    text(h.operationName) ??
    text(h.name) ??
    text(h.type) ??
    text(h.targetId) ??
    undefined
  );
}

function handlersOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.map(handlerName).filter((n): n is string => !!n);
}

/**
 * The event wiring of a decoded `internal_event_mappings`; `null` when the
 * shape is unknown. Accepts `{source: [handlers]}`, `{source: {event:
 * [handlers]}}` and `[{sourceElementId|elementId, event|eventName,
 * handlers|targets}]`.
 */
export function eventWiring(value: unknown): UibEventWiring[] | null {
  if (value === null || value === undefined) return [];
  const out: UibEventWiring[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObj(item)) continue;
      const source =
        text(item.sourceElementId) ?? text(item.elementId) ?? text(item.source);
      if (!source) continue;
      const event = text(item.event) ?? text(item.eventName);
      out.push({
        source,
        ...(event ? { event } : {}),
        handlers: handlersOf(item.handlers ?? item.targets),
      });
    }
  } else if (isObj(value)) {
    for (const [source, v] of Object.entries(value)) {
      if (isObj(v) && !("definition" in v)) {
        for (const [event, handlers] of Object.entries(v)) {
          out.push({ source, event, handlers: handlersOf(handlers) });
        }
      } else {
        out.push({ source, handlers: handlersOf(v) });
      }
    }
  } else {
    return null;
  }
  return out.slice(0, COMPOSITION_MAX_ELEMENTS);
}
