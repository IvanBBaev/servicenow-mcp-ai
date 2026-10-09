import { assertPackageAllowed } from "../core/policy.js";
import {
  type AccessReview,
  readAccessReview,
  renderAccessReview,
} from "./access-review.js";
import {
  PURPOSE_BLOCK,
  VISIBILITY_CAVEAT,
  caveatsSection,
  code,
  type RenderContext,
} from "./doc-shared.js";

/**
 * N-22 (NX-31) — the `access_review` document kind of
 * servicenow_document_instance: the privileged roles, their holders with the
 * grant path, dormant accounts and recent revokes (readAccessReview).
 *
 * Unlike the other kinds it holds account data (user names, last logins,
 * role grants), so it is not metadata-only and it follows the `directory`
 * package: with SN_PACKAGES_DENY=directory the kind is refused before any
 * read, and the run lists it under `failed`.
 */

export const ACCOUNT_DATA_CAVEAT =
  "Account data: user names, last logins and role grants of privileged accounts are in this document; treat it like the directory data it comes from.";

export async function collectAccessReview(): Promise<AccessReview> {
  assertPackageAllowed("directory");
  return readAccessReview();
}

/** Render the access-review document (pure: same review, same bytes). */
export function renderAccessReviewDoc(
  review: AccessReview,
  ctx: RenderContext,
): string {
  return [
    `# Access review — profile ${code(ctx.profile)}`,
    "",
    "Generated from the privileged role grants (sys_user_role, sys_user_role_contains, sys_user_has_role, sys_audit_delete; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    ...PURPOSE_BLOCK,
    "## Privileged access",
    "",
    ...renderAccessReview(review),
    ...caveatsSection([ACCOUNT_DATA_CAVEAT, VISIBILITY_CAVEAT]),
  ].join("\n");
}

/** Tables whose records the document holds. */
export function accessReviewSources(review: AccessReview): string[] {
  return [
    ...(review.accounts.length ? ["sys_user_has_role"] : []),
    ...(review.revokes.rows.length ? ["sys_audit_delete"] : []),
  ];
}
