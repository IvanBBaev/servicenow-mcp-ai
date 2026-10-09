// P-16 explain_portal renderers: the Mermaid layout tree and the Markdown
// report, driven directly with hand-built results so every optional field
// (named and sys_id-only fallbacks) is exercised.
import test from "node:test";
import assert from "node:assert/strict";

import { portalMarkdown, portalMermaid } from "../build/api/portal-render.js";

const counts = {
  pages: 1,
  containers: 1,
  rows: 1,
  columns: 1,
  instances: 1,
  widgets: 1,
  dependencies: 1,
};

const base = (over = {}) => ({
  mode: "portal",
  pages: [],
  widgets: [],
  routeMaps: [],
  counts,
  depth: 2,
  verified: false,
  caveats: [],
  unreadable: [],
  ...over,
});

const instance = (over = {}) => ({
  sys_id: "inst1",
  order: 1,
  widget: { sys_id: "w1", name: "Hero" },
  options: [],
  ...over,
});

const column = (over = {}) => ({
  sys_id: "col1",
  order: 1,
  instances: [instance()],
  rows: [],
  ...over,
});

const page = (over = {}) => ({
  sys_id: "pg1",
  id: "index",
  roles_in_portal: [],
  layout: [
    {
      sys_id: "c1",
      order: 1,
      rows: [{ sys_id: "r1", order: 1, columns: [column()] }],
    },
  ],
  ...over,
});

test("portalMermaid: a full portal names theme, menu, pages and nested rows", () => {
  const nested = column({
    sys_id: "col2",
    size: "6",
    instances: [instance({ sys_id: "inst2", title: "Search", widget: null })],
    rowsOmitted: 2,
  });
  const result = base({
    portal: { sys_id: "p1", title: "Service Portal", url_suffix: "sp" },
    theme: {
      sys_id: "t1",
      name: "Stock",
      header: null,
      footer: null,
      jsIncludes: [],
      cssIncludes: [],
    },
    menu: { sys_id: "m1", title: "Main", items: [] },
    pages: [
      page({
        title: "Home",
        roles_in_portal: ["itil", "admin"],
        layout: [
          {
            sys_id: "c1",
            order: 1,
            name: "main",
            rows: [
              {
                sys_id: "r1",
                order: 1,
                columns: [
                  column({
                    rows: [{ sys_id: "r2", order: 1, columns: [nested] }],
                  }),
                ],
              },
            ],
          },
        ],
      }),
    ],
  });
  const { mermaid, truncated } = portalMermaid(result);
  assert.equal(truncated, 0);
  for (const text of [
    "Portal: Service Portal /sp",
    "Theme: Stock",
    "Menu: Main",
    "Page: Home (index) · itil, admin",
    "Container: main",
    "Column 6",
    "Search · no widget",
    "+2 nested row(s)",
  ]) {
    assert.ok(mermaid.includes(text), `${text} in\n${mermaid}`);
  }
});

test("portalMermaid: sys_id fallbacks, and a page without a portal is the root", () => {
  const sysIdOnly = portalMermaid(
    base({
      portal: { sys_id: "p1" },
      theme: {
        sys_id: "t1",
        header: null,
        footer: null,
        jsIncludes: [],
        cssIncludes: [],
      },
      menu: { sys_id: "m1", items: [] },
    }),
  ).mermaid;
  for (const text of ["Portal: p1", "Theme: t1", "Menu: m1"]) {
    assert.ok(sysIdOnly.includes(text), text);
  }
  assert.ok(!sysIdOnly.includes("/undefined"));

  const pageMode = portalMermaid(
    base({
      mode: "page",
      pages: [page({ id: "", layout: undefined })],
    }),
  ).mermaid;
  assert.ok(pageMode.includes("Page: (pg1)"), pageMode);
  assert.ok(!pageMode.includes("Portal"));
});

test("portalMarkdown: a full report covers every section", () => {
  const result = base({
    portal: { sys_id: "p1", title: "Service Portal", url_suffix: "sp" },
    theme: {
      sys_id: "t1",
      name: "Stock",
      header: { sys_id: "h1", name: "Header A" },
      footer: { sys_id: "f1", id: "footer-id" },
      jsIncludes: [{ sys_id: "j1", name: "lib.js" }, { sys_id: "j2" }],
      cssIncludes: [{ sys_id: "s1", name: "theme.css" }, { sys_id: "s2" }],
    },
    menu: {
      sys_id: "m1",
      title: "Main",
      items: [
        {
          sys_id: "i1",
          label: "Home",
          type: "page",
          url: "?id=index",
          order: 1,
        },
        { sys_id: "i2", order: 2 },
      ],
    },
    pages: [
      page({
        title: "Home",
        layout: [
          {
            sys_id: "c1",
            order: 1,
            name: "main",
            width: "container-fluid",
            rows: [
              {
                sys_id: "r1",
                order: 1,
                columns: [
                  column({
                    size: "12",
                    instances: [
                      instance({
                        title: "Hero",
                        options: [
                          { name: "color", set: true, value: "red\nblue" },
                          { name: "size", set: false, default: "md" },
                          { name: "obj", set: true, value: { a: 1 } },
                          { name: "long", set: true, value: "x".repeat(200) },
                        ],
                        unknownOptions: { stray: 1 },
                        parametersDecoded: false,
                        parametersReason: "bad JSON",
                      }),
                    ],
                    rows: [
                      {
                        sys_id: "r2",
                        order: 1,
                        columns: [column({ sys_id: "col3", instances: [] })],
                      },
                    ],
                    rowsOmitted: 3,
                  }),
                ],
              },
            ],
          },
          { sys_id: "c2", order: 2, rows: [] },
        ],
      }),
      page({ sys_id: "pg2", id: "later", layoutOmitted: true }),
    ],
    widgets: [
      {
        sys_id: "w1",
        id: "hero",
        name: "Hero",
        optionSchema: [{ name: "color" }, { name: "size" }],
        instances: 1,
        dependencies: [
          {
            sys_id: "d1",
            name: "Charts",
            jsIncludes: [{ sys_id: "j1", name: "chart.js" }],
            cssIncludes: [{ sys_id: "s9" }],
          },
          { sys_id: "d2", jsIncludes: [], cssIncludes: [] },
        ],
        providers: [
          { sys_id: "pr1", name: "spModal", type: "service" },
          { sys_id: "pr2" },
        ],
        templates: [{ sys_id: "tp1", id: "tpl.html" }, { sys_id: "tp2" }],
      },
      {
        sys_id: "w2",
        optionSchema: [],
        instances: 0,
        dependencies: [],
        providers: [],
        templates: [],
      },
    ],
    routeMaps: [
      {
        sys_id: "rm1",
        short_description: "Old home",
        route_from_page: "home",
        route_to_page: "index",
        active: "false",
      },
      { sys_id: "rm2" },
    ],
    caveats: ["verified:false"],
    missingFields: { sp_page: ["public", "roles"] },
  });
  const md = portalMarkdown(result, "flowchart TD");
  for (const text of [
    "# Portal Service Portal (/sp)",
    "## Theme",
    "- **Stock**",
    "- Header: Header A",
    "- Footer: footer-id",
    "- JS include: lib.js",
    "- JS include: j2",
    "- CSS include: theme.css",
    "- CSS include: s2",
    "## Menu Main",
    "- Home (page) → ?id=index",
    "- i2",
    "### Home (index)",
    "- Container main (container-fluid)",
    "  - Column 12",
    "**Hero · Hero**",
    "- color = red blue",
    '- obj = {"a":1}',
    `- long = ${"x".repeat(117)}...`,
    "- stray = 1 _(not in option_schema)_",
    "_widget_parameters did not decode: bad JSON_",
    "_3 nested row(s) past depth_",
    "- Container\n",
    "_Layout not read (page limit)._",
    "## Widgets",
    "- **Hero** (hero): 1 instance(s)",
    "  - Options: color, size",
    "  - Dependency Charts: chart.js, s9",
    "  - Dependency d2\n",
    "  - Angular provider spModal (service)",
    "  - Angular provider pr2\n",
    "  - ng-template tpl.html",
    "  - ng-template tp2",
    "- **w2**: 0 instance(s)",
    "## Route maps",
    "- Old home: home → index (inactive)",
    "- rm2: ? → ?",
    "```mermaid\nflowchart TD\n```",
    "- verified:false",
    "- sp_page: fields not returned: public, roles",
  ]) {
    assert.ok(md.includes(text), `missing ${JSON.stringify(text)}`);
  }
  assert.ok(!md.includes("- size ="), "an unset option is not listed");
});

test("portalMarkdown: page mode titles, sys_id fallbacks and an empty result", () => {
  const sysIdOnly = portalMarkdown(
    base({
      portal: { sys_id: "p1" },
      theme: {
        sys_id: "t1",
        header: { sys_id: "h1" },
        footer: null,
        jsIncludes: [],
        cssIncludes: [],
      },
      menu: { sys_id: "m1", items: [] },
    }),
    "x",
  );
  assert.ok(sysIdOnly.startsWith("# Portal p1\n"), sysIdOnly);
  assert.ok(sysIdOnly.includes("- **t1**"));
  assert.ok(sysIdOnly.includes("- Header: h1"));
  assert.ok(sysIdOnly.includes("## Menu m1"));
  assert.ok(!sysIdOnly.includes("## Widgets"));
  assert.ok(!sysIdOnly.includes("## Route maps"));

  const pageMode = portalMarkdown(
    base({ mode: "page", pages: [page({ layout: undefined })] }),
    "x",
  );
  assert.ok(pageMode.startsWith("# Page (index)\n"), pageMode);

  const empty = portalMarkdown(base({ mode: "page" }), "x");
  assert.ok(empty.startsWith("# Page (unreadable)\n"), empty);
});
