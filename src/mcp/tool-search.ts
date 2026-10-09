/**
 * N-36 — tool discovery: rank the session's tools against an intent so a
 * client on the small `core` surface can find a tool in a package it has not
 * loaded, then enable that package with servicenow_enable_package. Pure: the
 * catalog comes from the PackageSession, so denied packages and the write
 * tools of read-only packages are never offered.
 */

/** One searchable tool, as the PackageSession tracks it. */
export interface ToolEntry {
  name: string;
  package: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** Its package is enabled in this session, so the tool is callable now. */
  enabled: boolean;
}

export interface ToolMatch extends ToolEntry {
  score: number;
}

export const FIND_TOOLS_DEFAULT_LIMIT = 8;

/** Words that carry no intent; dropped from the query. */
const STOPWORDS = new Set(
  "a an and are by can do find for from get how i in into is it me my of on or show the this to tool tools use what which with".split(
    " ",
  ),
);

/** Lower-case word stems: split on non-alphanumerics, drop a plural ending. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => {
      if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
      if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
        return w.slice(0, -1);
      return w;
    });
}

/** One word is a prefix of the other, both at least four letters long. */
const prefixOf = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

/**
 * Score each tool against `query`: a term in the tool name weighs 3, in the
 * package name 2, in the title 2, in the description 1; a prefix match (one
 * word starting the other) counts half. Ties keep enabled tools first, then name order. Tools that match no
 * term are left out.
 */
export function findTools(
  catalog: readonly ToolEntry[],
  query: string,
  options: { limit?: number } = {},
): ToolMatch[] {
  const wanted = [...new Set(terms(query))].filter((t) => !STOPWORDS.has(t));
  const matches: ToolMatch[] = [];
  for (const tool of catalog) {
    const fields: Array<[string[], number]> = [
      [terms(tool.name.replace(/^servicenow_/, "")), 3],
      [[tool.package], 2],
      [terms(tool.title), 2],
      [terms(tool.description), 1],
    ];
    let score = 0;
    for (const t of wanted) {
      let best = 0;
      for (const [words, weight] of fields) {
        if (words.includes(t)) best = Math.max(best, weight);
        else if (words.some((w) => prefixOf(w, t)))
          best = Math.max(best, weight / 2);
      }
      score += best;
    }
    if (score > 0) matches.push({ ...tool, score });
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.enabled) - Number(a.enabled) ||
      a.name.localeCompare(b.name),
  );
  return matches.slice(0, options.limit ?? FIND_TOOLS_DEFAULT_LIMIT);
}
