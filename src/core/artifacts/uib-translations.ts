import { elementProps, flattenComposition } from "./uib-composition-diff.js";
import { isSysId } from "../sys-id.js";

/**
 * N-31 (UX-23) — the strings a UI Builder page shows to users, read from its
 * `composition`, and how they compare with the macroponent's declared
 * `required_translations`. Pure; the N-7 i18n kind can check these strings
 * against `sys_ui_message` / `sys_translated_text` for a language later.
 *
 * A prop value is translatable when it is a literal string with a letter in
 * it that is not a binding, sys_id or URL, and either the prop name reads as
 * user-facing text (label, title, message, placeholder, …) or the value is a
 * typed translation literal (`{type: "TRANSLATION_LITERAL", value}` or an
 * object flagged `translatable: true`).
 *
 * ASSUMPTION (unverified until O-5, PDI): the typed translation literal
 * shape, and that `required_translations` is an array of strings or of
 * `{message|key|text|value|label}` objects (or an object keyed by message).
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Translatable strings reported per page (the rest are counted). */
export const TRANSLATIONS_MAX = 500;

/** Characters kept per string. */
const TEXT_MAX = 300;

/** Prop names (last segment) that carry user-facing text. */
const TEXT_PROP =
  /(^|[._-])(label|title|subtitle|heading|header|text|message|placeholder|tooltip|description|caption|helpText|hint|emptyState\w*|ariaLabel|alt|confirmText|cancelText|buttonText)$/i;

const BINDING = /@(data|state|context|payload)\./;
const URL_LIKE = /^(https?:)?\/\/|^\/[\w./?=&%-]*$/;

/** One user-facing string of a composition. */
export interface UibTranslatableString {
  text: string;
  elementId: string;
  /** The qualified prop name (`label`, `config.title`, `overrides.x.label`). */
  prop: string;
}

function isText(s: string): boolean {
  const t = s.trim();
  return (
    t.length > 0 &&
    /\p{L}/u.test(t) &&
    !isSysId(t) &&
    !BINDING.test(t) &&
    !URL_LIKE.test(t)
  );
}

/** The string of a typed translation literal, if `v` is one. */
function typedTranslation(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const typed =
    (typeof v.type === "string" && /TRANSLAT/i.test(v.type)) ||
    v.translatable === true;
  if (!typed) return undefined;
  const inner = isObj(v.value) ? (v.value.message ?? v.value.value) : v.value;
  const s = typeof inner === "string" ? inner : v.message;
  return typeof s === "string" ? s : undefined;
}

/** A literal string inside a `{type: "LITERAL", value}` wrapper. */
function literalString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (
    isObj(v) &&
    typeof v.type === "string" &&
    /LITERAL/i.test(v.type) &&
    typeof v.value === "string"
  ) {
    return v.value;
  }
  return undefined;
}

/**
 * The user-facing strings of a decoded composition, in document order,
 * one entry per element and prop, at most TRANSLATIONS_MAX.
 */
export function translatableStrings(composition: unknown): {
  strings: UibTranslatableString[];
  omitted: number;
} {
  const strings: UibTranslatableString[] = [];
  let omitted = 0;
  for (const el of flattenComposition(composition).elements.values()) {
    for (const [prop, v] of elementProps(el.raw)) {
      const typed = typedTranslation(v);
      const s =
        typed ??
        (TEXT_PROP.test(prop.split(".").pop() ?? prop)
          ? literalString(v)
          : undefined);
      if (s === undefined || !isText(s)) continue;
      if (strings.length >= TRANSLATIONS_MAX) {
        omitted++;
        continue;
      }
      strings.push({
        text: s.trim().slice(0, TEXT_MAX),
        elementId: el.elementId,
        prop,
      });
    }
  }
  return { strings, omitted };
}

/**
 * The messages a decoded `required_translations` declares; `null` when the
 * shape is unknown, `[]` when empty.
 */
export function declaredTranslations(value: unknown): string[] | null {
  if (value === null || value === undefined || value === "") return [];
  const out: string[] = [];
  const add = (s: unknown): void => {
    if (typeof s === "string" && s.trim()) out.push(s.trim());
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item);
      else if (isObj(item)) {
        add(
          [item.message, item.key, item.text, item.value, item.label].find(
            (x) => typeof x === "string" && x.trim(),
          ),
        );
      }
    }
  } else if (isObj(value)) {
    for (const k of Object.keys(value)) add(k);
  } else {
    return null;
  }
  return [...new Set(out)].sort();
}

/** The page's translatable strings against its declared translations. */
export interface RequiredTranslations {
  /** Unique user-facing strings of the composition, sorted. */
  texts: string[];
  /** Where each string is used. */
  strings: UibTranslatableString[];
  /** `required_translations` messages; `null` when its shape is unknown. */
  declared: string[] | null;
  /** Composition strings not in `declared` (empty when `declared` is null). */
  undeclared: string[];
  /** Strings past TRANSLATIONS_MAX. */
  omitted?: number;
}

/**
 * The strings a page needs translated (N-31, UX-23): the composition's
 * user-facing literals, the declared `required_translations`, and the
 * strings the declaration misses. Both inputs are decoded values.
 */
export function requiredTranslations(
  composition: unknown,
  declaredValue?: unknown,
): RequiredTranslations {
  const { strings, omitted } = translatableStrings(composition);
  const texts = [...new Set(strings.map((s) => s.text))].sort();
  const declared = declaredTranslations(declaredValue);
  const known = new Set(declared ?? []);
  return {
    texts,
    strings,
    declared,
    undeclared: declared ? texts.filter((t) => !known.has(t)) : [],
    ...(omitted ? { omitted } : {}),
  };
}
