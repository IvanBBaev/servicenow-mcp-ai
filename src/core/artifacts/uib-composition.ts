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
 *
 * N-26 adds opt-in depth on top of the same walk: element props / config /
 * overrides with their binding expressions (`compositionTree(v, {props:
 * true})`), and structured event handlers (`eventMappings`). The prop and
 * handler shapes (`propertyValues`, `{type: "STATE_BINDING", binding:
 * {address}}`, `{type, definition, targetId, operationName, parameters}`) are
 * modelled on UI Builder exports and are verified:false until O-5.
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

/** Props read per element (the rest are counted in `propsOmitted`). */
export const ELEMENT_MAX_PROPS = 50;

/** Characters of a literal prop value kept (longer values are cut). */
const LITERAL_MAX = 200;

/**
 * How a prop gets its value (N-26, UX-02): bound to a data resource output
 * (`@data.*`), client state (`@state.*`), page context (`@context.*`) or an
 * event payload (`@payload.*`); a literal; a client transform script; or an
 * `expression` that mixes literals with one or more bindings.
 */
export type UibBindingKind =
  | "data"
  | "state"
  | "context"
  | "payload"
  | "literal"
  | "script"
  | "expression";

/** One prop of an element (N-26). verified:false until O-5. */
export interface UibProp {
  name: string;
  /** Where the prop sits: `propertyValues` / `props`, `config` or `overrides`. */
  source: "props" | "config" | "overrides";
  kind: UibBindingKind;
  /** Binding expressions, normalised to `@data.a.b` / `@state.x` / … */
  bindings?: string[];
  /** A literal value (cut to 200 characters when long). */
  value?: unknown;
}

/** One element of the component tree. */
export interface UibElement {
  elementId: string;
  /** `definition.id` — the component / macroponent sys_id or tag. */
  component?: string;
  /** `definition.type` (e.g. MACROPONENT, COMPONENT). */
  type?: string;
  label?: string;
  hidden?: true;
  /** N-26: props, config and overrides (only with `{props: true}`). */
  props?: UibProp[];
  /** N-26: props past ELEMENT_MAX_PROPS. */
  propsOmitted?: number;
  slots: { name: string; elements: UibElement[] }[];
}

/** Options of {@link compositionTree}. */
export interface CompositionOptions {
  /** N-26: keep element props, config, overrides and bindings. */
  props?: boolean;
}

const BINDING_KINDS = ["data", "state", "context", "payload"] as const;

const EXPRESSION =
  /@(data|state|context|payload)\.([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+|\[[^\]]{0,40}\])*)/g;

/** The binding kind a typed value object names (`STATE_BINDING`, …). */
function typedKind(type: string): UibBindingKind | undefined {
  const t = type.toUpperCase();
  if (/DATA(_OUTPUT)?_BINDING|^DATA_?BROKER/.test(t)) return "data";
  if (/STATE_BINDING|CLIENT_STATE/.test(t)) return "state";
  if (/CONTEXT_BINDING/.test(t)) return "context";
  if (/PAYLOAD_BINDING|EVENT_PAYLOAD/.test(t)) return "payload";
  if (/SCRIPT|TRANSFORM/.test(t)) return "script";
  if (/LITERAL/.test(t)) return "literal";
  return undefined;
}

/** `@kind.a.b` from a binding `address` (array or dotted string). */
function addressExpr(kind: string, binding: unknown): string | undefined {
  const b = isObj(binding) ? (binding.address ?? binding.path) : binding;
  const parts = Array.isArray(b)
    ? b.filter((p) => typeof p === "string" || typeof p === "number")
    : typeof b === "string" && b
      ? [b.replace(/^@\w+\./, "")]
      : [];
  return parts.length ? `@${kind}.${parts.join(".")}` : undefined;
}

/** Binding expressions anywhere inside a value, bounded. */
function bindingsIn(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || out.size >= 20) return;
  if (typeof v === "string") {
    for (const m of v.matchAll(EXPRESSION)) out.add(`@${m[1]}.${m[2]}`);
  } else if (Array.isArray(v)) {
    for (const x of v) bindingsIn(x, out, depth + 1);
  } else if (isObj(v)) {
    const kind = text(v.type) ? typedKind(v.type as string) : undefined;
    if (kind && (BINDING_KINDS as readonly string[]).includes(kind)) {
      const expr = addressExpr(kind, v.binding ?? v.value);
      if (expr) out.add(expr);
      return;
    }
    for (const x of Object.values(v)) bindingsIn(x, out, depth + 1);
  }
}

function literal(v: unknown): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  if (s.length <= LITERAL_MAX) return v;
  return `${s.slice(0, LITERAL_MAX - 3)}...`;
}

/** Classify one prop value (N-26). Never throws. */
export function classifyProp(v: unknown): Omit<UibProp, "name" | "source"> {
  if (typeof v === "string") {
    const whole = /^\s*@(data|state|context|payload)\.[^\s]+\s*$/.exec(v);
    const found = new Set<string>();
    bindingsIn(v, found);
    if (whole && found.size === 1) {
      return { kind: whole[1] as UibBindingKind, bindings: [...found] };
    }
    if (found.size) return { kind: "expression", bindings: [...found] };
    return { kind: "literal", value: literal(v) };
  }
  if (isObj(v) && text(v.type)) {
    const kind = typedKind(v.type as string);
    if (kind && (BINDING_KINDS as readonly string[]).includes(kind)) {
      const expr = addressExpr(kind, v.binding ?? v.value);
      return { kind, ...(expr ? { bindings: [expr] } : {}) };
    }
    if (kind === "script") return { kind };
    if (kind === "literal") {
      const inner = classifyProp(v.value);
      return inner.kind === "literal"
        ? {
            kind,
            ...(v.value !== undefined ? { value: literal(v.value) } : {}),
          }
        : inner;
    }
  }
  const found = new Set<string>();
  bindingsIn(v, found);
  if (found.size) return { kind: "expression", bindings: [...found] };
  const value = literal(v);
  return { kind: "literal", ...(value !== undefined ? { value } : {}) };
}

/** The props of one element: `propertyValues` / `props`, `config`, `overrides`. */
function propsOf(item: Obj): { props: UibProp[]; omitted: number } {
  const all: UibProp[] = [];
  const add = (source: UibProp["source"], name: string, v: unknown): void => {
    all.push({ name, source, ...classifyProp(v) });
  };
  const bag = isObj(item.propertyValues)
    ? item.propertyValues
    : isObj(item.props)
      ? item.props
      : undefined;
  if (bag) for (const [k, v] of Object.entries(bag)) add("props", k, v);
  if (isObj(item.config)) {
    for (const [k, v] of Object.entries(item.config)) add("config", k, v);
  }
  if (isObj(item.overrides)) {
    for (const [k, v] of Object.entries(item.overrides)) {
      const inner = isObj(v)
        ? isObj(v.propertyValues)
          ? v.propertyValues
          : isObj(v.props)
            ? v.props
            : undefined
        : undefined;
      if (inner) {
        for (const [p, pv] of Object.entries(inner)) {
          add("overrides", `${k}.${p}`, pv);
        }
      } else add("overrides", k, v);
    }
  }
  // A bound visibility answers "why is this element hidden?".
  if (item.isHidden !== undefined && typeof item.isHidden !== "boolean") {
    add("props", "isHidden", item.isHidden);
  }
  return {
    props: all.slice(0, ELEMENT_MAX_PROPS),
    omitted: Math.max(0, all.length - ELEMENT_MAX_PROPS),
  };
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
export function compositionTree(
  value: unknown,
  opts: CompositionOptions = {},
): CompositionTree {
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
      if (opts.props) {
        const { props, omitted } = propsOf(item);
        if (props.length) el.props = props;
        if (omitted) el.propsOmitted = omitted;
      }
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
 * Walk a decoded `internal_event_mappings` with a handler reader; `null` when
 * the shape is unknown. Accepts `{source: [handlers]}`, `{source: {event:
 * [handlers]}}` and `[{sourceElementId|elementId, event|eventName,
 * handlers|targets}]`.
 */
function walkMappings<H>(
  value: unknown,
  read: (v: unknown) => H[],
): { source: string; event?: string; handlers: H[] }[] | null {
  if (value === null || value === undefined) return [];
  const out: { source: string; event?: string; handlers: H[] }[] = [];
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
        handlers: read(item.handlers ?? item.targets),
      });
    }
  } else if (isObj(value)) {
    for (const [source, v] of Object.entries(value)) {
      if (isObj(v) && !("definition" in v)) {
        for (const [event, handlers] of Object.entries(v)) {
          out.push({ source, event, handlers: read(handlers) });
        }
      } else {
        out.push({ source, handlers: read(v) });
      }
    }
  } else {
    return null;
  }
  return out.slice(0, COMPOSITION_MAX_ELEMENTS);
}

/**
 * The event wiring of a decoded `internal_event_mappings`; `null` when the
 * shape is unknown. Accepts `{source: [handlers]}`, `{source: {event:
 * [handlers]}}` and `[{sourceElementId|elementId, event|eventName,
 * handlers|targets}]`.
 */
export function eventWiring(value: unknown): UibEventWiring[] | null {
  return walkMappings(value, handlersOf);
}

/**
 * One event handler with the fields that say what it targets (N-26, UX-03).
 * verified:false until O-5: the field names are modelled on UI Builder
 * exports (`definition`, `type`, `targetId`, `operationName`, `parameters`).
 */
export interface UibEventHandler {
  /** The short name {@link eventWiring} reports. */
  name?: string;
  /** `type` (or `definition.type`), e.g. CLIENT_SCRIPT, DATABROKER_OP. */
  type?: string;
  /** `definition.id` — a client script / event sys_id or a built-in id. */
  definitionId?: string;
  /** The element or data resource the handler acts on. */
  targetId?: string;
  /** A data resource operation (`operationName`). */
  operation?: string;
  /** A client state property the handler sets. */
  property?: string;
  /** Parameter names passed to the handler. */
  params?: string[];
}

/** One wired event with structured handlers (N-26). */
export interface UibEventMapping {
  source: string;
  event?: string;
  handlers: UibEventHandler[];
}

function structuredHandler(h: unknown): UibEventHandler | undefined {
  if (typeof h === "string") return h ? { name: h } : undefined;
  if (!isObj(h)) return undefined;
  const def = isObj(h.definition) ? h.definition : {};
  const params = isObj(h.parameters)
    ? h.parameters
    : isObj(h.params)
      ? h.params
      : undefined;
  const param = (k: string): string | undefined => {
    const v = params?.[k];
    if (typeof v === "string") return v || undefined;
    if (isObj(v)) return text(v.value);
    return undefined;
  };
  const name = handlerName(h);
  const type = text(h.type) ?? text(def.type);
  const definitionId = text(def.id);
  const targetId =
    text(h.targetId) ??
    text(h.target) ??
    text(h.elementId) ??
    text(h.dataResourceId);
  const operation =
    text(h.operationName) ?? text(h.operation) ?? param("operationName");
  const property =
    text(h.propName) ??
    text(h.stateName) ??
    text(h.statePropertyName) ??
    param("propName") ??
    param("name");
  const out: UibEventHandler = {
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(operation ? { operation } : {}),
    ...(property ? { property } : {}),
    ...(params && Object.keys(params).length
      ? { params: Object.keys(params).slice(0, 20) }
      : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function structuredHandlersOf(v: unknown): UibEventHandler[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.map(structuredHandler).filter((h): h is UibEventHandler => !!h);
}

/**
 * The event wiring of a decoded `internal_event_mappings` with structured
 * handlers (N-26); same shapes and bounds as {@link eventWiring}.
 */
export function eventMappings(value: unknown): UibEventMapping[] | null {
  return walkMappings(value, structuredHandlersOf);
}
