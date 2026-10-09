import { renderHardening } from "./hardening.js";
import { getMaxRecords } from "../core/settings.js";
import {
  type SecurityCheckName,
  type SecurityFinding,
  type SecurityScan,
} from "./security.js";
import {
  caveatsSection,
  code,
  METADATA_CAVEAT,
  PURPOSE_BLOCK,
  type RenderContext,
  tableOrNone,
  VISIBILITY_CAVEAT,
} from "./doc-shared.js";

/**
 * Security document (ID-23).
 */

/** SecurityCheckName in declaration order: the document's section order. */
export const SECURITY_CHECK_ORDER: readonly SecurityCheckName[] = [
  "acl_roles",
  "role_inheritance",
  "public_rest_resources",
  "public_ui_pages",
  "tables_without_acl",
  "admin_overlap_roles",
  "elevated_privilege_acls",
  "ux_data_brokers",
];

/** Which check a finding belongs to; `undefined` for the ACL script rules. */
function checkOf(f: SecurityFinding): SecurityCheckName | undefined {
  switch (f.rule) {
    case "acl-roles-only":
    case "acl-open":
    case "acl-public-role":
      return "acl_roles";
    case "public-rest-resource":
      return "public_rest_resources";
    case "public-ui-page":
    case "public-page":
      return "public_ui_pages";
    case "table-no-acl":
      return "tables_without_acl";
    case "admin-overlap-role":
      return "admin_overlap_roles";
    case "acl-elevated-privilege":
      return "elevated_privilege_acls";
    case "uib-broker-mutates-no-acl":
    case "ux-broker-acl-open":
      return "ux_data_brokers";
    default:
      return undefined;
  }
}

const MATRIX_RULES = new Set([
  "acl-open",
  "acl-public-role",
  "acl-elevated-privilege",
  "acl-roles-only",
]);

const MATRIX_OPERATIONS = ["create", "read", "write", "delete"] as const;

/** Table × operation → the roles each ACL requires (`public` for none). */
export function aclMatrix(
  findings: readonly SecurityFinding[],
): { table: string; cells: Record<string, string[]> }[] {
  const seen = new Set<string>();
  const rows = new Map<string, Record<string, string[]>>();
  for (const f of findings) {
    if (!MATRIX_RULES.has(f.rule) || !f.roles || seen.has(f.sys_id)) continue;
    seen.add(f.sys_id);
    const table = f.table ?? f.name.split(".")[0] ?? f.name;
    const op = f.operation;
    if (!(MATRIX_OPERATIONS as readonly string[]).includes(op)) continue;
    const row = rows.get(table) ?? {};
    const entry = f.roles.length ? [...f.roles].sort().join(", ") : "public";
    const list = row[op] ?? [];
    if (!list.includes(entry)) list.push(entry);
    row[op] = list.sort();
    rows.set(table, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, cells]) => ({ table, cells }));
}

function findingRows(findings: SecurityFinding[]): string[][] {
  return findings.map((f) => [
    f.severity,
    f.rule,
    code(f.name),
    f.operation,
    (f.roles ?? []).join(", "),
    f.hint,
  ]);
}

const FINDING_HEADER = [
  "Severity",
  "Rule",
  "Name",
  "Operation",
  "Roles",
  "Hint",
];

/** Render the security document (pure: same scan, same bytes). */
export function renderSecurity(scan: SecurityScan, ctx: RenderContext): string {
  const lines: string[] = [
    `# Security review — profile ${code(ctx.profile)}`,
    "",
    "Generated from the security scan of servicenow_check_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Scan available:** ${scan.available ? "yes" : "no"}`,
    ...(scan.unavailableReason
      ? [`- **Unavailable:** ${scan.unavailableReason}`]
      : []),
    `- **Active ACLs scanned:** ${scan.aclCount}`,
    `- **Findings:** ${scan.findings.length} (error ${scan.bySeverity.error}, warn ${scan.bySeverity.warn}, info ${scan.bySeverity.info})`,
    "",
    ...PURPOSE_BLOCK,
  ];
  const caveats: string[] = [];
  if (scan.truncated) {
    const why =
      scan.truncatedReason === "cap"
        ? `SN_MAX_RECORDS (${getMaxRecords()})`
        : scan.truncatedReason === "scan_limit"
          ? "the fetchAll scan budget (the instance withheld most rows)"
          : scan.truncatedReason === "ceiling"
            ? "the scan's own row ceiling"
            : "an unknown limit";
    caveats.push(
      `Truncated: the ACL read stopped at ${why} before the last active ACL; the findings and the matrix are partial.`,
    );
  }
  if (scan.filtered) {
    caveats.push(
      `Filtered: the instance counted ${scan.filtered} ACL row(s) it did not return to this user; they are not in this document.`,
    );
  }
  // N-13: hardening compliance does not depend on the ACL read.
  const hardening = scan.hardening
    ? ["## Hardening", "", ...renderHardening(scan.hardening)]
    : [];
  if (!scan.available) {
    lines.push(
      ...hardening,
      ...caveatsSection([
        ...caveats,
        "No access-control data could be read, so this document holds no findings. Re-run with a user that can read sys_security_acl.",
        METADATA_CAVEAT,
      ]),
    );
    return lines.join("\n");
  }

  const matrix = aclMatrix(scan.findings);
  lines.push(
    "## ACL matrix",
    "",
    "Roles each flagged ACL requires, per table and operation (`public` = no role). Only ACLs the scan flagged are listed — an ACL with a condition or script and roles appears only when a rule flagged it.",
    "",
    tableOrNone(
      ["Table", ...MATRIX_OPERATIONS],
      matrix.map((r) => [
        code(r.table),
        ...MATRIX_OPERATIONS.map((op) => (r.cells[op] ?? []).join("; ")),
      ]),
    ),
    "",
    "## Checks",
    "",
  );

  const scripts = scan.findings.filter((f) => checkOf(f) === undefined);
  lines.push(
    "### ACL scripts",
    "",
    tableOrNone(FINDING_HEADER, findingRows(scripts)),
    "",
  );
  for (const name of SECURITY_CHECK_ORDER) {
    const check = scan.checks?.[name];
    const findings = scan.findings.filter((f) => checkOf(f) === name);
    lines.push(`### ${code(name)}`, "");
    if (check) {
      lines.push(
        check.available
          ? `Scanned ${check.scanned} row(s), ${findings.length} finding(s)${check.truncated ? " — the read stopped early, so the result may be partial" : ""}.`
          : `Unavailable: ${check.unavailableReason ?? "the check's table could not be read."}`,
        ...(check.note ? ["", `Note: ${check.note}`] : []),
        "",
      );
      if (check.truncated) {
        caveats.push(
          `${name}: the check's read stopped early; its result may be partial.`,
        );
      }
    }
    lines.push(tableOrNone(FINDING_HEADER, findingRows(findings)), "");
  }
  lines.push(
    ...hardening,
    ...caveatsSection([...caveats, VISIBILITY_CAVEAT, METADATA_CAVEAT]),
  );
  return lines.join("\n");
}
