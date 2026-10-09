import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import { isSysId } from "../core/sys-id.js";
import { readUserRoles } from "./access-explain.js";
import { unreadableReason } from "./security.js";
import { mdEscape, mdTable, snString } from "./shared.js";
import { keyQuery, queryTable, type SnRecord } from "./table.js";

/**
 * N-27 (UX-05) — which UI Builder variant one user sees: for each route of an
 * experience, the screen variants in order, each matched against the user's
 * roles through its audience (`sys_ux_applicability.roles`), its screen
 * conditions (`sys_ux_screen_condition`) and the experience's
 * `sys_ux_app_config.roles`.
 *
 * The first active variant whose audience the user is in is the one shown;
 * the variants after it are shadowed. A variant with screen conditions
 * depends on the page context (the record, the parameters), so it is
 * `undetermined`, like a script part in N-2; an undetermined variant before
 * the first certain match makes the route undetermined, and every candidate
 * up to that match is listed.
 *
 * Privacy per O-13: reading another user's roles is the `directory` package's
 * surface; only role names leave this module (H-5).
 *
 * Read-only; never throws except on bad input or a cancel. An unreadable
 * table degrades to `available:false`. Unverified until O-5 (PDI): the
 * `sys_ux_app_config.roles` and `sys_ux_applicability.roles` value format
 * (role names or sys_ids, both handled), an inactive audience (taken as not
 * matching), the admin role passing every audience, and the
 * `sys_ux_screen_condition.screen` link.
 */

/** Routes read for one experience. */
export const VARIANT_ROUTE_LIMIT = 200;
/** Screen, audience and condition rows read per query. */
export const VARIANT_ROW_LIMIT = 1_000;

export type VariantResult = "match" | "no-match" | "undetermined" | "inactive";
export type RouteDecision = "resolved" | "undetermined" | "none";

export interface VariantAudience {
  sys_id: string;
  name?: string;
  roles: string[];
  active: boolean;
}

export interface VariantEvaluation {
  sys_id: string;
  name?: string;
  order: number;
  audience?: VariantAudience;
  conditions: number;
  result: VariantResult;
  reason: string;
}

export interface RouteResolution {
  sys_id: string;
  name?: string;
  decision: RouteDecision;
  /** The variant shown, when the decision is `resolved`. */
  variant?: string;
  /** The variants that may be shown, in order, when `undetermined`. */
  candidates: string[];
  /** Variants the user would also pass, behind the shown one (or the last candidate). */
  shadowed: string[];
  variants: VariantEvaluation[];
}

export interface UiVariantResolution {
  available: boolean;
  unavailableReason?: string;
  user: string;
  roles: string[];
  admin: boolean;
  experience?: { sys_id: string; title?: string; path?: string };
  /** The app config's roles and whether the user passes them. */
  appConfig?: { sys_id: string; roles: string[]; access: boolean };
  routes: RouteResolution[];
  notes: string[];
}

export interface ResolveUiVariantInput {
  /** sys_ux_page_registry sys_id or path (e.g. `now/sow`). */
  experience: string;
  /** user_name or sys_id. */
  user: string;
  /** Only the route with this name or sys_id. */
  route?: string;
}

function badInput(message: string): ServiceNowError {
  return new ServiceNowError(message, 400);
}

function validate(input: ResolveUiVariantInput): void {
  if (!input.user.trim() || /[\^,=]/.test(input.user)) {
    throw badInput("user must be a user_name or sys_id without ^ , =");
  }
  if (!input.experience.trim() || /[\^,=]/.test(input.experience)) {
    throw badInput("experience must be a sys_ux_page_registry path or sys_id");
  }
  if (input.route !== undefined && /[\^,=]/.test(input.route)) {
    throw badInput("route must be a route name or sys_id without ^ , =");
  }
}

/** Comma-separated list values, trimmed. */
export function listValues(value: unknown): string[] {
  return snString(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Whether one role list admits the user: empty admits everyone. */
export function rolesAdmit(
  required: readonly string[],
  roles: ReadonlySet<string>,
): boolean {
  if (required.length === 0 || roles.has("admin")) return true;
  return required.some((r) => roles.has(r));
}

/** Evaluate one variant against the user's roles. */
export function evaluateVariant(
  screen: {
    sys_id: string;
    name?: string;
    order: number;
    active: boolean;
    conditions: number;
  },
  audience: VariantAudience | undefined,
  missingAudience: boolean,
  roles: ReadonlySet<string>,
): VariantEvaluation {
  const base = {
    sys_id: screen.sys_id,
    ...(screen.name ? { name: screen.name } : {}),
    order: screen.order,
    ...(audience ? { audience } : {}),
    conditions: screen.conditions,
  };
  const at = (result: VariantResult, reason: string): VariantEvaluation => ({
    ...base,
    result,
    reason,
  });
  if (!screen.active) return at("inactive", "The variant is inactive.");
  if (missingAudience) {
    return at("undetermined", "The audience record could not be read.");
  }
  if (audience && !audience.active) {
    return at("no-match", "The audience is inactive.");
  }
  if (audience && !rolesAdmit(audience.roles, roles)) {
    return at(
      "no-match",
      `The user has none of the audience roles (${audience.roles.join(", ")}).`,
    );
  }
  const who = !audience
    ? "No audience: every user."
    : audience.roles.length === 0
      ? "The audience has no roles: every user."
      : roles.has("admin") && !audience.roles.some((r) => roles.has(r))
        ? "admin passes the audience roles."
        : "The user has an audience role.";
  if (screen.conditions > 0) {
    return at(
      "undetermined",
      `${who} ${screen.conditions} screen condition(s) depend on the page context.`,
    );
  }
  return at("match", who);
}

/** Decide one route from its variants in order. */
export function decideRoute(
  variants: readonly VariantEvaluation[],
): Pick<RouteResolution, "decision" | "variant" | "candidates" | "shadowed"> {
  const candidates: string[] = [];
  let stop = variants.length;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    if (v.result === "undetermined") candidates.push(v.sys_id);
    if (v.result === "match") {
      stop = i;
      break;
    }
  }
  const shown = variants[stop];
  const lastCandidate = candidates.length
    ? variants.findIndex((v) => v.sys_id === candidates.at(-1))
    : -1;
  const after = shown ? stop : lastCandidate;
  const shadowed =
    after < 0
      ? []
      : variants
          .slice(after + 1)
          .filter((v) => v.result === "match" || v.result === "undetermined")
          .map((v) => v.sys_id);
  if (candidates.length === 0) {
    return shown
      ? { decision: "resolved", variant: shown.sys_id, candidates, shadowed }
      : { decision: "none", candidates, shadowed: [] };
  }
  if (shown) candidates.push(shown.sys_id);
  return { decision: "undetermined", candidates, shadowed };
}

async function read(
  table: string,
  query: string,
  fields: string[],
  limit = VARIANT_ROW_LIMIT,
  order?: string,
): Promise<SnRecord[]> {
  const { records } = await queryTable({
    table,
    query: order ? `${query}^ORDERBY${order}` : query,
    fields,
    displayValue: "false",
    limit,
  });
  return records;
}

/** Role names for role names or sys_user_role sys_ids. */
async function roleNames(values: readonly string[]): Promise<string[]> {
  const ids = values.filter(isSysId);
  const names = values.filter((v) => !isSysId(v));
  if (ids.length) {
    const rows = await read(
      "sys_user_role",
      `sys_idIN${[...new Set(ids)].join(",")}`,
      ["sys_id", "name"],
    );
    const byId = new Map(
      rows.map((r) => [snString(r.sys_id), snString(r.name)]),
    );
    for (const id of ids) names.push(byId.get(id) || id);
  }
  return [...new Set(names)].sort();
}

const flag = (v: unknown): boolean => snString(v) !== "false";
const num = (v: unknown): number => Number(snString(v)) || 0;

/** Which variant of each route of one experience one user sees. */
export async function resolveUiVariant(
  input: ResolveUiVariantInput,
): Promise<UiVariantResolution> {
  validate(input);
  const base: UiVariantResolution = {
    available: false,
    user: input.user,
    roles: [],
    admin: false,
    routes: [],
    notes: [],
  };
  let table = "sys_user_has_role";
  try {
    const user = await readUserRoles(input.user);
    if (!user.sysId) {
      return { ...base, unavailableReason: `No user "${input.user}".` };
    }
    const roles = new Set(user.roles);
    const out: UiVariantResolution = {
      ...base,
      roles: user.roles,
      admin: roles.has("admin"),
    };

    table = "sys_ux_page_registry";
    const exp = input.experience.trim();
    const [page] = await read(
      table,
      isSysId(exp) ? `sys_id=${exp}` : keyQuery({ path: exp }),
      ["sys_id", "title", "path", "admin_panel"],
      1,
    );
    if (!page) {
      return { ...out, unavailableReason: `No experience "${exp}".` };
    }
    out.experience = {
      sys_id: snString(page.sys_id),
      ...(snString(page.title) ? { title: snString(page.title) } : {}),
      ...(snString(page.path) ? { path: snString(page.path) } : {}),
    };
    const configId = snString(page.admin_panel);
    if (!configId) {
      out.notes.push(
        "The experience has no admin_panel (sys_ux_app_config): no routes to resolve.",
      );
      return { ...out, available: true };
    }

    table = "sys_ux_app_config";
    const [config] = await read(
      table,
      `sys_id=${configId}`,
      ["sys_id", "roles"],
      1,
    );
    const configRoles = await roleNames(listValues(config?.roles));
    out.appConfig = {
      sys_id: configId,
      roles: configRoles,
      access: rolesAdmit(configRoles, roles),
    };
    if (!out.appConfig.access) {
      out.notes.push(
        "The user has none of the app config roles: the experience is not shown to them.",
      );
    }

    table = "sys_ux_app_route";
    const route = input.route?.trim();
    const routeRows = await read(
      table,
      `app_config=${configId}${
        route ? `^${isSysId(route) ? "sys_id" : "name"}=${route}` : ""
      }`,
      ["sys_id", "name", "screen_type", "order"],
      VARIANT_ROUTE_LIMIT,
      "order",
    );
    if (routeRows.length === VARIANT_ROUTE_LIMIT) {
      out.notes.push(
        `Only the first ${VARIANT_ROUTE_LIMIT} routes are resolved.`,
      );
    }
    const types = [
      ...new Set(routeRows.map((r) => snString(r.screen_type)).filter(Boolean)),
    ];

    table = "sys_ux_screen";
    const screens = types.length
      ? await read(
          table,
          `screen_typeIN${types.join(",")}`,
          ["sys_id", "name", "screen_type", "applicability", "order", "active"],
          VARIANT_ROW_LIMIT,
          "order",
        )
      : [];
    const screenIds = screens.map((s) => snString(s.sys_id));
    const audienceIds = [
      ...new Set(screens.map((s) => snString(s.applicability)).filter(Boolean)),
    ];

    table = "sys_ux_applicability";
    const audiences = new Map<string, VariantAudience>();
    if (audienceIds.length) {
      for (const a of await read(table, `sys_idIN${audienceIds.join(",")}`, [
        "sys_id",
        "name",
        "roles",
        "active",
      ])) {
        audiences.set(snString(a.sys_id), {
          sys_id: snString(a.sys_id),
          ...(snString(a.name) ? { name: snString(a.name) } : {}),
          roles: await roleNames(listValues(a.roles)),
          active: flag(a.active),
        });
      }
    }

    table = "sys_ux_screen_condition";
    const conditions = new Map<string, number>();
    if (screenIds.length) {
      for (const c of await read(table, `screenIN${screenIds.join(",")}`, [
        "sys_id",
        "screen",
      ])) {
        const s = snString(c.screen);
        conditions.set(s, (conditions.get(s) ?? 0) + 1);
      }
    }

    for (const r of routeRows) {
      const type = snString(r.screen_type);
      const variants = screens
        .filter((s) => type && snString(s.screen_type) === type)
        .sort((a, b) => num(a.order) - num(b.order))
        .map((s) => {
          const id = snString(s.sys_id);
          const audienceId = snString(s.applicability);
          return evaluateVariant(
            {
              sys_id: id,
              ...(snString(s.name) ? { name: snString(s.name) } : {}),
              order: num(s.order),
              active: flag(s.active),
              conditions: conditions.get(id) ?? 0,
            },
            audiences.get(audienceId),
            !!audienceId && !audiences.has(audienceId),
            roles,
          );
        });
      out.routes.push({
        sys_id: snString(r.sys_id),
        ...(snString(r.name) ? { name: snString(r.name) } : {}),
        ...decideRoute(variants),
        variants,
      });
    }
    if (route && out.routes.length === 0) {
      out.notes.push(`No route "${route}" in the experience.`);
    }
    if (out.admin) {
      out.notes.push(
        "admin is taken to pass every role list (unverified until O-5).",
      );
    }
    return { ...out, available: true };
  } catch (error) {
    rethrowIfCancelled(error);
    return { ...base, unavailableReason: unreadableReason(table, error) };
  }
}

/** Markdown for a resolution. */
export function renderUiVariantResolution(r: UiVariantResolution): string[] {
  const name = r.experience?.title ?? r.experience?.path ?? "experience";
  const lines = [`# Variants of ${mdEscape(name)} for ${mdEscape(r.user)}`, ""];
  if (!r.available) {
    lines.push(`Unavailable: ${r.unavailableReason ?? "unknown"}`);
    return lines;
  }
  lines.push(
    `Roles: ${r.roles.length ? r.roles.map((x) => `\`${x}\``).join(", ") : "none"}`,
  );
  if (r.appConfig) {
    lines.push(
      `App config roles: ${
        r.appConfig.roles.length ? r.appConfig.roles.join(", ") : "none"
      } — ${r.appConfig.access ? "passes" : "**does not pass**"}`,
    );
  }
  for (const route of r.routes) {
    const shown =
      route.decision === "resolved"
        ? `shows \`${route.variant}\``
        : route.decision === "undetermined"
          ? `undetermined between ${route.candidates.map((c) => `\`${c}\``).join(", ")}`
          : "no variant matches";
    lines.push(
      "",
      `## Route ${mdEscape(route.name ?? route.sys_id)} — ${shown}`,
      "",
      mdTable(
        ["Order", "Variant", "Audience", "Conditions", "Result", "Reason"],
        route.variants.map((v) => [
          String(v.order),
          v.name ?? v.sys_id,
          v.audience ? (v.audience.name ?? v.audience.sys_id) : "—",
          String(v.conditions),
          route.shadowed.includes(v.sys_id)
            ? `${v.result} (shadowed)`
            : v.result,
          v.reason,
        ]),
      ),
    );
  }
  if (r.notes.length) {
    lines.push("", ...r.notes.map((n) => `- ${n}`));
  }
  return lines;
}
