import { PURPOSE_BLOCK, code, type CollectOptions } from "./doc-shared.js";
import {
  type I18nCoverageReport,
  i18nCoverage,
  i18nCoverageSections,
} from "./i18n-coverage.js";

/**
 * N-7 (NX-07) — the `i18n` document kind of servicenow_document_app:
 * `<profile>/i18n/<scope>.md` + `.json`, the translation coverage of one
 * scoped app (i18nCoverage) with the missing keys per language and category.
 * `language` narrows the report to one language; without it every active
 * `sys_language` except the base language is measured.
 */

export async function collectI18n(
  scope: string,
  opts: CollectOptions,
): Promise<I18nCoverageReport> {
  return i18nCoverage({
    scope,
    ...(opts.language ? { languages: [opts.language] } : {}),
  });
}

/** Render the translation-coverage document (pure: same report, same bytes). */
export function renderI18nDoc(report: I18nCoverageReport): string {
  return [
    `# Translation coverage — ${code(report.scope ?? "")}`,
    "",
    "Generated from the scope's translation tables and UI Builder macroponents (the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    ...PURPOSE_BLOCK,
    ...i18nCoverageSections(report),
  ].join("\n");
}

/** Tables whose rows the document reports on. */
export function i18nSources(report: I18nCoverageReport): string[] {
  return [
    ...new Set(
      report.sources
        .filter((s) => s.status === "read" && s.rows > 0)
        .map((s) => s.table),
    ),
  ];
}
