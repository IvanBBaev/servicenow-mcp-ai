/**
 * P-14 / P-15 — the shapes of `explain_ui_experience`: its options, the page
 * map it returns and the `detail` depth levels. Read by ui-experience.ts and
 * rendered by ui-experience-render.ts; import from ui-experience.ts.
 */

import type {
  CompositionTree,
  UibBindingKind,
  UibDataResource,
  UibEventWiring,
  UibProp,
  UibStateProperty,
} from "../core/artifacts/uib-composition.js";
import type { EncodedQueryTerm } from "./query-explain.js";
import type { UibPageFinding, UibPageMetrics } from "./uib-page-lint.js";
import type { UibBrokerFinding } from "./uib-broker-lint.js";
import type { Unreadable } from "./bounded-read.js";
import type {
  UxDeclarativeAction,
  UxFormView,
  UxShell,
  UxTheme,
  UxWorkspaceClass,
} from "./uib-workspace.js";

/** N-26 depth levels of {@link explainUiExperience}. */
export const UI_EXPERIENCE_DETAILS = [
  "elements",
  "bindings",
  "events",
  "scripts",
] as const;
export type UiExperienceDetail = (typeof UI_EXPERIENCE_DETAILS)[number];

export interface ExplainUiExperienceOptions {
  /** sys_ux_page_registry sys_id. */
  sys_id?: string;
  /** sys_ux_page_registry path (e.g. 'now/sow'). */
  path?: string;
  /** N-26: opt-in depth (one level or several); none by default. */
  detail?: UiExperienceDetail | readonly UiExperienceDetail[];
}

/** A decoded JSON column: its reading, or the raw value when it did not. */
export interface DecodedColumn<T> {
  decoded: boolean;
  value?: T;
  reason?: string;
  raw?: string;
}

export interface UxApplicability {
  sys_id: string;
  name?: string;
  roles: string[];
  active?: string;
}

export interface UxScreen {
  sys_id: string;
  name?: string;
  order: number;
  macroponent?: string;
  applicability?: string;
  active?: string;
}

export interface UxRoute {
  sys_id: string;
  name?: string;
  route_type?: string;
  screen_type?: string;
  parent_macroponent?: string;
  order: number;
  /** Screen variants of the route's screen type, in evaluation order. */
  screens: UxScreen[];
}

/** A script body (N-26, `detail: "scripts"`). */
export interface UxScriptBody {
  script?: string;
  /** Characters cut past UI_SCRIPT_MAX. */
  scriptTruncated?: number;
}

/**
 * N-26 (UX-04): what an element's `definition.id` renders. `oob` is a
 * `now-*` / `sn-*` component (by its tag, with or without a
 * sys_ux_lib_component row), `custom` any other sys_ux_lib_component,
 * `macroponent` a nested sys_ux_macroponent. `artifactType` is the registry
 * type to pass to get_artifact / explain_artifact.
 */
export interface UxComponent {
  id: string;
  kind: "oob" | "custom" | "macroponent" | "unresolved";
  sys_id?: string;
  name?: string;
  tag?: string;
  category?: string;
  table?: string;
  artifactType?: "uib_component" | "uib_macroponent";
  /** Elements of this macroponent that render it. */
  elements: string[];
}

/** N-26 (UX-02): one binding expression and what it resolves to. */
export interface UxBinding {
  elementId: string;
  prop: string;
  source: UibProp["source"];
  kind: UibBindingKind;
  expression: string;
  resolves?: {
    /** `@data.<dataResource>.…` */
    dataResource?: string;
    broker?: string;
    brokerName?: string;
    /** `@state.<state>` */
    state?: string;
    /** Whether the state property is declared on the macroponent. */
    declared?: boolean;
    /** `@context.<path>`: page context, resolved at run time. */
    context?: string;
  };
}

/** N-26 (UX-03): what one handler does. */
export interface UxEventTarget {
  kind: "clientScript" | "brokerOperation" | "state" | "event" | "unknown";
  name?: string;
  sys_id?: string;
  /** The handler's own `type`, as read. */
  type?: string;
  dataResource?: string;
  operation?: string;
  broker?: string;
  brokerName?: string;
  property?: string;
  declared?: boolean;
}

/** N-26 (UX-03): source element → event → handler targets. */
export interface UxEventChain {
  source: string;
  /** The composition element the source names, when found. */
  element?: string;
  component?: string;
  event?: string;
  targets: UxEventTarget[];
}

export interface UxMacroponent {
  sys_id: string;
  name?: string;
  category?: string;
  composition: DecodedColumn<CompositionTree>;
  data: DecodedColumn<UibDataResource[]>;
  state: DecodedColumn<UibStateProperty[]>;
  events: DecodedColumn<UibEventWiring[]>;
  clientScripts: ({
    sys_id: string;
    name?: string;
    type?: string;
  } & UxScriptBody)[];
  /** N-26 `elements`: components rendered by this macroponent. */
  components?: UxComponent[];
  /** N-26 `bindings`. */
  bindings?: UxBinding[];
  /** N-26 `events`. */
  eventChains?: UxEventChain[];
  /** N-31 `elements`: the page weight metrics (uib-page-weight). */
  pageMetrics?: UibPageMetrics;
  /** N-31 `elements`: user-facing strings against `required_translations`. */
  translations?: UxTranslations;
}

/**
 * N-31 (UX-23): the translatable strings of one macroponent's composition.
 * `sample` holds up to UI_TRANSLATION_SAMPLE undeclared strings, or the
 * first strings when the declaration could not be read (`declared: null`).
 */
export interface UxTranslations {
  /** Element / prop uses of user-facing strings. */
  strings: number;
  /** Unique strings. */
  texts: number;
  /** Messages in `required_translations`; null when unreadable. */
  declared: number | null;
  /** Unique strings missing from `required_translations`. */
  undeclared: number;
  sample: string[];
  /** Strings past the per-page cap (TRANSLATIONS_MAX). */
  omitted?: number;
}

/**
 * N-31 (UX-22): `uib-page-weight` findings of one macroponent. The rule's
 * hint is the same for every finding, so it is left out here (it is in
 * UIB_PAGE_RULES and the markdown section).
 */
export interface UxPageHint {
  macroponent: string;
  name?: string;
  /** Screen variants that render the macroponent. */
  screens?: string[];
  findings: Omit<UibPageFinding, "hint">[];
  /** The composition or data hit a cap or has an unknown shape. */
  partial?: true;
}

/**
 * N-29 (UX-11): broker rule findings of one data broker. The rule hints are
 * the same for every finding, so they are left out here (they are in
 * UIB_BROKER_RULES and the markdown section).
 */
export interface UxBrokerHint {
  broker: string;
  name?: string;
  table: string;
  findings: Omit<UibBrokerFinding, "hint">[];
}

export interface UxDataBroker extends UxScriptBody {
  sys_id: string;
  table: string;
  name?: string;
  mutates_server_data?: string;
  acls: {
    sys_id: string;
    name?: string;
    operation?: string;
    active?: string;
  }[];
}

export interface UxDashboard {
  sys_id: string;
  name?: string;
  active?: string;
  tabs: {
    sys_id: string;
    name?: string;
    order: number;
    widgets: { sys_id: string; name?: string; component?: string }[];
  }[];
}

export interface UxListMenu {
  sys_id: string;
  name?: string;
  active?: string;
  categories: {
    sys_id: string;
    title?: string;
    order: number;
    lists: {
      sys_id: string;
      title?: string;
      table?: string;
      condition?: string;
      /** N-30: `columns`, split. */
      columns?: string[];
      /** N-30: `condition` read by the encoded-query reader. */
      conditionTerms?: EncodedQueryTerm[];
      order: number;
      applicability: string[];
    }[];
  }[];
}

export interface UxFormActionLayout {
  sys_id: string;
  name?: string;
  table?: string;
  items: {
    sys_id: string;
    order: number;
    form_action?: string;
    label?: string;
    action?: string;
    applicability?: string;
  }[];
}

export interface UxProperty {
  sys_id: string;
  name: string;
  type?: string;
  value?: unknown;
}

export interface UxCounts {
  routes: number;
  screens: number;
  macroponents: number;
  elements: number;
  dataResources: number;
  clientScripts: number;
  dataBrokers: number;
  acls: number;
  applicabilities: number;
  dashboards: number;
  listMenus: number;
  lists: number;
  formActionLayouts: number;
  /** N-30 */
  actions: number;
  themes: number;
}

export interface ExplainUiExperienceResult {
  experience: {
    sys_id: string;
    title?: string;
    path?: string;
    root_macroponent?: string;
    admin_panel?: string;
    sys_scope?: string;
    active?: string;
  } | null;
  appConfig: { sys_id: string; name?: string; landing_path?: string } | null;
  properties: UxProperty[];
  routes: UxRoute[];
  macroponents: UxMacroponent[];
  dataBrokers: UxDataBroker[];
  /** Broker ids referenced by data resources but found in no broker table. */
  unresolvedBrokers: string[];
  applicabilities: UxApplicability[];
  dashboards: UxDashboard[];
  listMenus: UxListMenu[];
  formActionLayouts: UxFormActionLayout[];
  /** N-30: root macroponent and decoded chrome (null without either). */
  shell: UxShell | null;
  /** N-30: declarative action assignments on the workspace's tables. */
  actions: UxDeclarativeAction[];
  /** N-30: the UX form of each table (layouts and positioned actions). */
  forms: UxFormView[];
  /** N-30: themes linked through m2m_app_theme. */
  themes: UxTheme[];
  /** N-30: Agent Workspace vs Configurable Workspace. */
  workspace: UxWorkspaceClass;
  /** N-31: `uib-page-weight` findings; omitted when no page has any. */
  pageHints?: UxPageHint[];
  /** N-29: broker rule findings; omitted when no broker has any. */
  brokerHints?: UxBrokerHint[];
  counts: UxCounts;
  /** N-26: the depth read, with its counts (only when `detail` is set). */
  detail?: {
    levels: UiExperienceDetail[];
    components: number;
    unresolvedComponents: number;
    bindings: number;
    eventChains: number;
    scripts: number;
    /** N-31 (`elements`): user-facing string uses across macroponents. */
    translatableStrings?: number;
    /** N-31 (`elements`): unique strings missing from the declarations. */
    undeclaredTranslations?: number;
  };
  verified: false;
  caveats: string[];
  unreadable: Unreadable[];
  missingFields?: Record<string, string[]>;
  /** Set when the root table itself could not be read. */
  degraded?: Unreadable;
  available?: boolean;
}
