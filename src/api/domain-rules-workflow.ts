import { type SnRecord } from "./table.js";
import {
  Collector,
  type Ctx,
  DOMAIN_CHILD_MAX,
  need,
  NEWEST,
  read,
  str,
} from "./domain-rules-shared.js";

/**
 * P-19 legacy-workflow rule (`workflow-migration-candidate`).
 */

export async function analyseWorkflows(
  ctx: Ctx,
  out: Collector,
): Promise<void> {
  await out.run(["workflow-migration-candidate"], async () => {
    const fields = ["sys_id", "name", "workflow", "workflow.name"];
    const items = await read(
      ctx,
      "sc_cat_item",
      `workflowISNOTEMPTY^${NEWEST}`,
      fields,
      DOMAIN_CHILD_MAX,
    );
    const slas = await read(
      ctx,
      "contract_sla",
      `workflowISNOTEMPTY^${NEWEST}`,
      fields,
      DOMAIN_CHILD_MAX,
    );
    if (!items && !slas) need(ctx, null, "sc_cat_item", "contract_sla");
    const byWf = new Map<
      string,
      { name?: string; catalogItems: string[]; slaDefinitions: string[] }
    >();
    const add = (r: SnRecord, key: "catalogItems" | "slaDefinitions") => {
      const wf = str(r, "workflow");
      if (!wf) return;
      const e = byWf.get(wf) ?? { catalogItems: [], slaDefinitions: [] };
      if (!e.name && str(r, "workflow.name")) e.name = str(r, "workflow.name");
      e[key].push(str(r, "name") || str(r, "sys_id"));
      byWf.set(wf, e);
    };
    for (const r of items?.rows ?? []) add(r, "catalogItems");
    for (const r of slas?.rows ?? []) add(r, "slaDefinitions");
    const truncated = !!items?.capped || !!slas?.capped;
    out.scanned(
      "workflow-migration-candidate",
      (items?.rows.length ?? 0) + (slas?.rows.length ?? 0),
      truncated,
    );
    const ordered = [...byWf.entries()].sort(
      ([, a], [, b]) =>
        b.catalogItems.length +
        b.slaDefinitions.length -
        (a.catalogItems.length + a.slaDefinitions.length),
    );
    for (const [id, e] of ordered.slice(0, ctx.limit)) {
      const parts = [
        e.catalogItems.length ? `${e.catalogItems.length} catalog item(s)` : "",
        e.slaDefinitions.length
          ? `${e.slaDefinitions.length} SLA definition(s)`
          : "",
      ].filter(Boolean);
      out.add(
        "workflow-migration-candidate",
        {
          artifactType: "workflow",
          table: "wf_workflow",
          sys_id: id,
          ...(e.name ? { name: e.name } : {}),
        },
        `Legacy workflow still referenced by ${parts.join(" and ")}: a migration candidate for Flow Designer (servicenow_explain_flow kind:'workflow' migration:true lists the references and running contexts).`,
        {
          catalogItems: e.catalogItems.slice(0, 20),
          slaDefinitions: e.slaDefinitions.slice(0, 20),
        },
      );
    }
    if (ordered.length > ctx.limit)
      out.scanned("workflow-migration-candidate", 0, true);
  });
}
