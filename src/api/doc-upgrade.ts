import {
  type SkippedReview,
  type StoreUpdates,
  type Unavailable,
  type UpgradeHistory,
  readSkipped,
  readStoreUpdates,
  readUpgradeHistory,
  renderSkipped,
  renderStoreUpdates,
  renderUpgradeHistory,
} from "./upgrade.js";
import {
  METADATA_CAVEAT,
  PURPOSE_BLOCK,
  VISIBILITY_CAVEAT,
  caveatsSection,
  code,
  type RenderContext,
} from "./doc-shared.js";

/**
 * N-1 (NX-01, NX-21) — the `upgrade` document kind of
 * servicenow_document_instance: the upgrade history, the unresolved skipped
 * records of the newest upgrade grouped by application and artefact type, and
 * the store apps with an update and their customised artefacts. The same
 * reads as servicenow_review_upgrade; one skipped record's base vs customer
 * review stays with the tool (update_name).
 */

export interface UpgradeDocData {
  history: UpgradeHistory | Unavailable;
  /** The newest upgrade's skips; absent when there is no upgrade to read. */
  skipped?: SkippedReview | Unavailable;
  store: StoreUpdates | Unavailable;
}

export async function collectUpgrade(): Promise<UpgradeDocData> {
  const history = await readUpgradeHistory();
  const newest = history.available ? history.upgrades[0] : undefined;
  const skipped = newest ? await readSkipped(newest.sys_id) : undefined;
  return { history, skipped, store: await readStoreUpdates() };
}

/** Render the upgrade document (pure: same data, same bytes). */
export function renderUpgradeDoc(
  data: UpgradeDocData,
  ctx: RenderContext,
): string {
  const newest = data.history.available ? data.history.upgrades[0] : undefined;
  return [
    `# Upgrade readiness — profile ${code(ctx.profile)}`,
    "",
    "Generated from the upgrade history and log, the update versions and the store apps (sys_upgrade_history, sys_upgrade_history_log, sys_store_app, sys_update_xml; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    ...PURPOSE_BLOCK,
    "## Upgrade history",
    "",
    ...renderUpgradeHistory(data.history),
    "",
    newest
      ? `## Skipped records — ${code(newest.toVersion || newest.sys_id)}`
      : "## Skipped records",
    "",
    ...(data.skipped
      ? renderSkipped(data.skipped)
      : ["_No upgrade to review._"]),
    "",
    "## Store app updates",
    "",
    ...renderStoreUpdates(data.store),
    ...caveatsSection([
      METADATA_CAVEAT,
      VISIBILITY_CAVEAT,
      "One skipped record's base vs customer versions: servicenow_review_upgrade with update_name.",
    ]),
  ].join("\n");
}

/** Tables whose records the document holds. */
export function upgradeSources(data: UpgradeDocData): string[] {
  return [
    ...(data.history.available && data.history.upgrades.length
      ? ["sys_upgrade_history"]
      : []),
    ...(data.skipped?.available && data.skipped.skipped
      ? ["sys_upgrade_history_log"]
      : []),
    ...(data.store.available && data.store.apps.length
      ? ["sys_store_app"]
      : []),
  ];
}
