import { createHash } from "node:crypto";
import { docsReadRaw, docsWriteRaw } from "./docs.js";
import type { Finding } from "./codecheck.js";
import type { SecurityScan } from "./security.js";
import type { DomainAnalysis } from "./domain-analysers.js";

/**
 * S-12 — the code-health baseline. `servicenow_check_code_health` keeps the
 * fingerprints of every finding it saw in `<profile>/code-health.baseline.json`
 * and reports what is new and what was fixed since. A fingerprint is
 * `unit|…`: the unit is what one read covers (one script for lint, one script
 * type for the registry sweep, one rule for the domain analysers). A
 * fingerprint missing from a unit the run did not read completely (a capped
 * type, an unreadable script, a truncated or unavailable check) is counted
 * `partial`, never `fixed`.
 */

export type BaselineSection = "lint" | "artifacts" | "security" | "domains";

export const BASELINE_SECTIONS: readonly BaselineSection[] = [
  "lint",
  "artifacts",
  "security",
  "domains",
];

/** Most `new` / `fixed` entries a delta lists (the counts cover all). */
export const BASELINE_DELTA_TOP = 50;

/** Fingerprints of one section of the current run. */
export interface SectionFacts {
  fingerprints: string[];
  /** Units not read completely: their missing fingerprints are not `fixed`. */
  partialUnits: Set<string>;
  /** The whole section was read incompletely. */
  partial?: boolean;
}

export interface SectionDelta {
  /** False when this section was recorded for the first time. */
  compared: boolean;
  new: number;
  fixed: number;
  unchanged: number;
  /** Baseline findings not seen, in units the run did not read completely. */
  partial: number;
}

export interface DeltaEntry {
  section: BaselineSection;
  fingerprint: string;
}

export interface CodeHealthDelta {
  baselineFile: string;
  /** True when this run created the baseline (or a section of it). */
  baselineCreated: boolean;
  /** When the compared baseline scope was taken. */
  baselineAt?: string;
  /** True when this run wrote the baseline file. */
  updated: boolean;
  sections: Partial<Record<BaselineSection, SectionDelta>>;
  newCount: number;
  fixedCount: number;
  new: DeltaEntry[];
  fixed: DeltaEntry[];
}

interface BaselineScope {
  takenAt: string;
  sections: Partial<Record<BaselineSection, string[]>>;
}

interface BaselineFile {
  version: 1;
  scopes: Record<string, BaselineScope>;
}

const unitOf = (fp: string) => fp.split("|", 1)[0] ?? "";

const shortHash = (text: string) =>
  createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 10);

/** Adds `#n` to repeats so two identical findings stay two fingerprints. */
function numbered(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return `${k}#${n}`;
  });
}

/**
 * Fingerprints of one script's findings. Line numbers are left out (an edit
 * above a finding must not make it "new"); the snippet hash and the
 * occurrence index tell findings of one rule apart.
 */
export function lintFingerprints(
  unit: string,
  field: string,
  findings: readonly Finding[],
): string[] {
  return numbered(
    findings.map((f) => `${unit}|${field}|${f.rule}|${shortHash(f.snippet)}`),
  );
}

export function securityFacts(scan: SecurityScan): SectionFacts {
  const checks = Object.values(scan.checks ?? {});
  return {
    fingerprints: numbered(
      scan.findings.map(
        (f) => `${f.rule}|${f.sys_id || f.table || f.name}|${f.operation}`,
      ),
    ),
    partialUnits: new Set(),
    partial:
      !scan.available ||
      scan.truncated === true ||
      checks.some((c) => !c.available || c.truncated),
  };
}

export function domainFacts(analysis: DomainAnalysis): SectionFacts {
  const partialUnits = new Set<string>();
  for (const [rule, r] of Object.entries(analysis.rules)) {
    if (!r.available || r.truncated) partialUnits.add(rule);
  }
  return {
    fingerprints: numbered(
      analysis.findings.map(
        (f) => `${f.rule}|${f.ref.artifactType}|${f.ref.sys_id}`,
      ),
    ),
    partialUnits,
  };
}

function compareSection(
  base: readonly string[],
  facts: SectionFacts,
): { delta: SectionDelta; added: string[]; fixed: string[]; keep: string[] } {
  const current = new Set(facts.fingerprints);
  const before = new Set(base);
  const added = [...current].filter((fp) => !before.has(fp)).sort();
  const fixed: string[] = [];
  const keep: string[] = [];
  let unchanged = 0;
  for (const fp of before) {
    if (current.has(fp)) {
      unchanged++;
    } else if (facts.partial || facts.partialUnits.has(unitOf(fp))) {
      keep.push(fp);
    } else {
      fixed.push(fp);
    }
  }
  fixed.sort();
  return {
    delta: {
      compared: true,
      new: added.length,
      fixed: fixed.length,
      unchanged,
      partial: keep.length,
    },
    added,
    fixed,
    keep,
  };
}

function parseBaseline(text: string | undefined): BaselineFile {
  if (!text) return { version: 1, scopes: {} };
  const obj: unknown = JSON.parse(text);
  const scopes = (obj as { scopes?: unknown } | null)?.scopes;
  if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
    return { version: 1, scopes: {} };
  }
  return { version: 1, scopes: scopes as Record<string, BaselineScope> };
}

/**
 * Compare the run with the stored baseline and, when a section is new to the
 * baseline or `update` is set, write it back. Without `update` an existing
 * section is never rewritten, so the delta is always against the same
 * reference (a ratchet the owner moves deliberately).
 */
export async function applyBaseline(opts: {
  profile: string;
  scopeKey: string;
  takenAt: string;
  sections: Partial<Record<BaselineSection, SectionFacts>>;
  update?: boolean;
}): Promise<CodeHealthDelta> {
  const baselineFile = `${opts.profile}/code-health.baseline.json`;
  const file = parseBaseline(await docsReadRaw(baselineFile, [".json"]));
  const stored = file.scopes[opts.scopeKey];
  const next: BaselineScope = {
    takenAt: stored?.takenAt ?? opts.takenAt,
    sections: { ...(stored?.sections ?? {}) },
  };
  const delta: CodeHealthDelta = {
    baselineFile,
    baselineCreated: false,
    ...(stored ? { baselineAt: stored.takenAt } : {}),
    updated: false,
    sections: {},
    newCount: 0,
    fixedCount: 0,
    new: [],
    fixed: [],
  };
  const added: DeltaEntry[] = [];
  const fixed: DeltaEntry[] = [];
  let write = false;
  for (const section of BASELINE_SECTIONS) {
    const facts = opts.sections[section];
    if (!facts) continue;
    const base = stored?.sections[section];
    if (!base) {
      delta.baselineCreated = true;
      delta.sections[section] = {
        compared: false,
        new: 0,
        fixed: 0,
        unchanged: 0,
        partial: 0,
      };
      next.sections[section] = [...new Set(facts.fingerprints)].sort();
      write = true;
      continue;
    }
    const c = compareSection(base, facts);
    delta.sections[section] = c.delta;
    added.push(...c.added.map((fingerprint) => ({ section, fingerprint })));
    fixed.push(...c.fixed.map((fingerprint) => ({ section, fingerprint })));
    if (opts.update) {
      // Findings of units this run could not read stay in the baseline.
      next.sections[section] = [
        ...new Set([...facts.fingerprints, ...c.keep]),
      ].sort();
      write = true;
    }
  }
  delta.newCount = added.length;
  delta.fixedCount = fixed.length;
  delta.new = added.slice(0, BASELINE_DELTA_TOP);
  delta.fixed = fixed.slice(0, BASELINE_DELTA_TOP);

  if (write) {
    if (opts.update) next.takenAt = opts.takenAt;
    file.scopes[opts.scopeKey] = next;
    const scopes = Object.fromEntries(
      Object.entries(file.scopes).sort(([a], [b]) => a.localeCompare(b)),
    );
    await docsWriteRaw(
      baselineFile,
      `${JSON.stringify({ version: 1, scopes }, null, 2)}\n`,
      [".json"],
      {
        generator: "servicenow_check_code_health",
        kind: "code-health-baseline",
        profile: opts.profile,
        generatedAt: opts.takenAt,
        // The hash covers the fingerprints, not when they were taken.
        source: {
          version: 1,
          scopes: Object.fromEntries(
            Object.entries(scopes).map(([k, v]) => [k, v.sections]),
          ),
        },
      },
    );
    delta.updated = true;
  }
  return delta;
}

/** The report section of a delta. */
export function deltaMarkdown(delta: CodeHealthDelta): string[] {
  const md = ["## Baseline delta", ""];
  const rows = Object.entries(delta.sections);
  md.push(
    delta.baselineAt && rows.some(([, s]) => s.compared)
      ? `Compared with the baseline taken ${delta.baselineAt} (\`${delta.baselineFile}\`): ${delta.newCount} new · ${delta.fixedCount} fixed.`
      : `Baseline recorded in \`${delta.baselineFile}\`; the next run reports new and fixed findings.`,
    "",
    "| Section | Compared | New | Fixed | Unchanged | Partial |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      ([name, s]) =>
        `| ${name} | ${s.compared ? "yes" : "recorded"} | ${s.new} | ${s.fixed} | ${s.unchanged} | ${s.partial} |`,
    ),
    "",
  );
  const list = (title: string, entries: DeltaEntry[]) => {
    if (entries.length === 0) return;
    md.push(
      `${title}:`,
      "",
      ...entries
        .slice(0, 20)
        .map(
          (e) => `- ${e.section}: \`${e.fingerprint.replaceAll("`", "'")}\``,
        ),
      "",
    );
  };
  list("New", delta.new);
  list("Fixed", delta.fixed);
  return md;
}
