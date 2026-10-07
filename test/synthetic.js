// Synthetic, anonymised ServiceNow payloads shared by the size goldens
// (N-57 response sizes, N-62 compact reads). Deterministic: the same index
// always yields the same row. `synthetic: true` until O-5 brings real sizes.

export const sysId = (prefix, i) =>
  `${prefix}${String(i).padStart(32 - prefix.length, "0")}`;
export const stamp = (i) =>
  `2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, "0")} 08:${String(i % 60).padStart(2, "0")}:00`;

/** The 100 columns of the synthetic incident, base fields first. */
export const INCIDENT_COLUMNS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "impact",
  "urgency",
  "category",
  "subcategory",
  "assignment_group",
  "assigned_to",
  "caller_id",
  "opened_at",
  "opened_by",
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
];
for (let n = INCIDENT_COLUMNS.length; n < 100; n += 1) {
  INCIDENT_COLUMNS.push(`u_custom_${String(n).padStart(3, "0")}`);
}

export function incident(i) {
  const row = {};
  for (const column of INCIDENT_COLUMNS) {
    switch (column) {
      case "sys_id":
        row[column] = sysId("a1", i);
        break;
      case "number":
        row[column] = `INC${String(10_000 + i).padStart(7, "0")}`;
        break;
      case "short_description":
        row[column] = `Synthetic incident ${i}: service degraded`;
        break;
      case "description":
        row[column] =
          `Synthetic description ${i}. Users report slow responses on the portal; ` +
          "the issue reproduces in two regions.";
        break;
      case "state":
      case "priority":
      case "impact":
      case "urgency":
        row[column] = String(1 + (i % 3));
        break;
      case "assignment_group":
      case "assigned_to":
      case "caller_id":
      case "opened_by":
        row[column] = sysId("b2", i % 7);
        break;
      case "opened_at":
      case "sys_created_on":
      case "sys_updated_on":
        row[column] = stamp(i);
        break;
      case "sys_created_by":
      case "sys_updated_by":
        row[column] = "synthetic.user";
        break;
      case "sys_mod_count":
        row[column] = String(i % 11);
        break;
      default:
        row[column] = i % 4 === 0 ? "" : `value ${column.slice(-3)}-${i}`;
    }
  }
  return row;
}
