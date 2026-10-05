// N-42: the Markdown alternate of the landing page. docs/index.html is the
// hand-written site; docs/index.md is rendered from its <main> content (plus
// the footer disclaimer) so an agent can read the page without 170 KB of
// markup, styles and scripts. The HTML links it with
// <link rel="alternate" type="text/markdown">. `npm run docs:sync` writes it
// through scripts/tool-docs.mjs; `--check` fails while it is stale.
//
// The converter is deliberately small: it knows the elements the landing page
// uses (headings, paragraphs, lists, tables, <pre>, <details>, inline
// emphasis, code and links) and drops the decoration (SVG, buttons, scripts,
// anything aria-hidden). It is not a general HTML-to-Markdown converter.

const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "wbr",
]);

/** Elements dropped with their whole subtree. */
const SKIP = new Set([
  "svg",
  "script",
  "style",
  "button",
  "input",
  "nav",
  "template",
]);

/** Elements that start a block of their own. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

/** Decoration that carries no reading content. */
const SKIP_CLASSES = new Set(["ico", "c-ico", "tabs", "term-bar", "to-top"]);

/** Containers whose children read best as a bullet list. */
const LIST_CLASSES = new Set(["badges", "stat-row"]);

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rarr: "→",
  larr: "←",
  harr: "↔",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  times: "×",
  check: "✓",
  copy: "©",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  le: "≤",
  ge: "≥",
  ne: "≠",
  bull: "•",
};

/** Decode the character references the page uses. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** A forgiving tree: { tag, attrs, children } nodes and string text nodes. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let last = 0;
  let m;
  const text = (t) => {
    if (t) stack.at(-1).children.push(t);
  };
  while ((m = re.exec(html)) !== null) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[3]), children: [] };
      stack.at(-1).children.push(node);
      const selfClosing = /\/\s*$/.test(m[3]);
      if (VOID.has(tag) || selfClosing) continue;
      if (tag === "script" || tag === "style") {
        // Raw text: skip to the closing tag.
        const close = html.toLowerCase().indexOf(`</${tag}`, last);
        const end = close === -1 ? html.length : close;
        node.children.push(html.slice(last, end));
        re.lastIndex = last = end;
        continue;
      }
      stack.push(node);
    }
  }
  text(html.slice(last));
  return root;
}

function classes(node) {
  return new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean));
}

function skipped(node) {
  if (typeof node === "string") return false;
  if (SKIP.has(node.tag)) return true;
  if (node.attrs["aria-hidden"] === "true" || "hidden" in node.attrs)
    return true;
  for (const c of classes(node)) if (SKIP_CLASSES.has(c)) return true;
  return false;
}

function isBlock(node) {
  return typeof node !== "string" && BLOCK.has(node.tag);
}

function find(node, test) {
  if (typeof node === "string") return undefined;
  if (test(node)) return node;
  for (const child of node.children) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return undefined;
}

function textContent(node) {
  if (typeof node === "string") return decodeEntities(node);
  if (skipped(node)) return "";
  if (node.tag === "br") return "\n";
  return node.children.map(textContent).join("");
}

/** Wrap `text` in `mark`, keeping surrounding spaces outside the marks. */
function wrap(text, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

/**
 * Inline children in order. Two elements that touch in the source (a stat
 * number and its label, a "read" pill and the tool name) are laid out apart
 * by CSS, so they get a space between them here.
 */
function joinInline(children, ctx) {
  let out = "";
  let prevElement = false;
  for (const child of children) {
    const piece = inline(child, ctx);
    if (!piece) continue;
    const element = typeof child !== "string";
    if (element && prevElement && !/\s$/.test(out) && !/^\s/.test(piece)) {
      out += " ";
    }
    out += piece;
    prevElement = element;
  }
  return out;
}

function inline(node, ctx) {
  if (typeof node === "string") {
    return decodeEntities(node).replace(/\s+/g, " ");
  }
  if (skipped(node)) return "";
  const inner = () => joinInline(node.children, ctx);
  switch (node.tag) {
    case "br":
      return ctx.table ? " " : "  \n";
    case "code": {
      const code = textContent(node).replace(/\s+/g, " ").trim();
      const fence = code.includes("`") ? "``" : "`";
      return code ? `${fence}${code}${fence}` : "";
    }
    case "strong":
    case "b":
      return wrap(inner(), "**");
    case "em":
    case "i":
      return wrap(inner(), "*");
    case "a": {
      const label = inner().trim();
      const href = node.attrs.href ?? "";
      // In-page anchors point into the HTML layout; keep the words only.
      if (!label || !href || href.startsWith("#")) return label;
      return `[${label}](${href})`;
    }
    default:
      return inner();
  }
}

function tidy(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, (s) => (s === "  " ? s : "")))
    .join("\n")
    .replace(/[ \t]{2,}(?=\S)/g, " ")
    .trim();
}

function cellText(node) {
  return tidy(inline(node, { table: true }))
    .replace(/\s+/g, " ")
    .replaceAll("|", "\\|");
}

function table(node) {
  const rows = [];
  const collect = (n) => {
    if (typeof n === "string" || skipped(n)) return;
    if (n.tag === "tr") {
      rows.push(
        n.children
          .filter(
            (c) => typeof c !== "string" && (c.tag === "th" || c.tag === "td"),
          )
          .map(cellText),
      );
      return;
    }
    n.children.forEach(collect);
  };
  collect(node);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];
  const line = (r) => `| ${pad(r).join(" | ")} |`;
  return [
    [
      line(rows[0]),
      line(Array(width).fill("---")),
      ...rows.slice(1).map(line),
    ].join("\n"),
  ];
}

function list(items, ordered) {
  return items.map((item, i) => {
    const marker = ordered ? `${i + 1}. ` : "- ";
    const body = blocks(item).join("\n\n");
    return marker + body.replace(/\n(?=.)/g, `\n${" ".repeat(marker.length)}`);
  });
}

/** Render a node as a list of Markdown blocks. */
function blocks(node) {
  if (typeof node === "string" || skipped(node)) {
    return typeof node === "string" ? paragraph([node]) : [];
  }
  const cls = classes(node);
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = tidy(inline(node, {})).replace(/\s+/g, " ");
      return text ? [`${"#".repeat(Number(node.tag[1]))} ${text}`] : [];
    }
    case "pre": {
      const code = textContent(node).replace(/^\n/, "").replace(/\s+$/, "");
      const fence = code.includes("```") ? "````" : "```";
      return code ? [`${fence}\n${code}\n${fence}`] : [];
    }
    case "table":
      return table(node);
    case "ul":
    case "ol":
      return [
        list(
          node.children.filter(
            (c) => typeof c !== "string" && c.tag === "li" && !skipped(c),
          ),
          node.tag === "ol",
        ).join("\n"),
      ].filter(Boolean);
    case "summary": {
      const text = tidy(inline(node, {})).replace(/\s+/g, " ");
      return text ? [text] : [];
    }
    case "hr":
      return ["---"];
    default:
      break;
  }
  if ([...cls].some((c) => LIST_CLASSES.has(c))) {
    const items = node.children.filter(
      (c) => typeof c !== "string" && !skipped(c),
    );
    const lines = items
      .map((c) => tidy(inline(c, {})).replace(/\s+/g, " "))
      .filter(Boolean)
      .map((t) => `- ${t}`);
    return lines.length ? [lines.join("\n")] : [];
  }
  return container(node.children);
}

function paragraph(nodes) {
  const text = tidy(joinInline(nodes, {}));
  return text ? [text] : [];
}

/** Group a mixed child list: runs of inline content become paragraphs. */
function container(children) {
  const out = [];
  let run = [];
  const flush = () => {
    out.push(...paragraph(run));
    run = [];
  };
  for (const child of children) {
    if (skipped(child)) continue;
    if (isBlock(child)) {
      flush();
      out.push(...blocks(child));
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

/** Plain HTML fragment → Markdown (exported for the tests). */
export function htmlToMarkdown(html) {
  const out = container(parseHtml(html).children);
  return out.length ? `${out.join("\n\n")}\n` : "";
}

/**
 * docs/index.html → docs/index.md: the <main> content and the footer
 * disclaimer under a header that names the HTML page and the generator.
 */
export function landingMarkdown(html, { siteUrl }) {
  const tree = parseHtml(html);
  const main = find(tree, (n) => n.tag === "main");
  if (!main) throw new Error("docs/index.html: no <main> element");
  const disclaimer = find(
    tree,
    (n) => n.tag === "p" && classes(n).has("disclaimer"),
  );
  const body = [
    ...container(main.children),
    ...(disclaimer ? blocks(disclaimer) : []),
  ];
  return (
    [
      `> The servicenow-mcp-ai documentation site (${siteUrl}/) as Markdown, generated from \`docs/index.html\` by \`npm run docs:sync\`. The tool reference is ${siteUrl}/llms-full.txt.`,
      ...body,
    ].join("\n\n") + "\n"
  );
}
