/**
 * N-50 — the MCP Apps (SEP-1865) views: four self-contained HTML documents
 * served as `ui://` resources. Each one is static (the same bytes for every
 * call), carries its CSS and script inline, loads nothing from the network
 * and receives the tool result from the host over the postMessage JSON-RPC
 * channel (`ui/initialize` → `ui/notifications/tool-result`).
 *
 * Record data is untrusted (M-4): every value reaches the DOM through `esc`,
 * only in element text or a constant class name, never in a URL, style or
 * event attribute. The document's own CSP forbids every fetch and eval.
 *
 * VIEW_SCRIPT is plain ES5 so the same text runs in any host webview and in
 * the tests (node:vm), which exercise the exact renderers that ship.
 */

import { createHash } from "node:crypto";

/** The views, keyed by the last segment of their `ui://` URI. */
export const APP_VIEW_IDS = [
  "plan-diff",
  "mermaid",
  "flow",
  "uib-tree",
] as const;
export type AppViewId = (typeof APP_VIEW_IDS)[number];

const DARK =
  "--bg:#0d1117;--fg:#e6edf3;--dim:#9198a1;--line:#3d444d;--box:#262c36;" +
  "--add:#12361e;--del:#3c1618;--chg:#3a3000";

const VIEW_STYLE =
  ":root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--dim:#59636e;--line:#d1d9e0;--box:#eef1f4;" +
  "--add:#dafbe1;--del:#ffebe9;--chg:#fff8c5}" +
  `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}` +
  `:root[data-theme=dark]{${DARK}}` +
  "body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,sans-serif}" +
  "h2{font-size:13px;margin:14px 0 6px}" +
  "table{border-collapse:collapse;width:100%;margin:4px 0}" +
  "th,td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}" +
  ".kv th{width:28%}" +
  "pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--box);padding:8px;border-radius:4px;max-height:420px;overflow:auto}" +
  "ul{margin:2px 0;padding-left:18px}" +
  ".tag{background:var(--box);border-radius:3px;padding:0 4px;font-size:11px}" +
  ".dim{color:var(--dim)}.add{background:var(--add)}.del{background:var(--del)}.chg{background:var(--chg)}" +
  ".err{color:#d1242f;font-weight:600}summary{cursor:pointer}";

/**
 * The renderers and the host handshake. Renderers build an HTML string in
 * which every datum went through `esc`; the bootstrap at the end only runs
 * in a browser (it returns at once without `document`).
 */
export const VIEW_SCRIPT = String.raw`"use strict";
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) {
  var s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/[&<>"']/g, function (c) { return ESC[c]; });
}
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function arr(v) { return Array.isArray(v) ? v : []; }
function has(v) { return v !== undefined && v !== null && v !== ""; }
function el(tag, cls, inner) { return "<" + tag + (cls ? ' class="' + cls + '"' : "") + ">" + inner + "</" + tag + ">"; }
function sec(title, body) { return body ? el("section", "", el("h2", "", esc(title)) + body) : ""; }
function kv(pairs) {
  var rows = "";
  pairs.forEach(function (p) { if (has(p[1])) rows += "<tr><th>" + esc(p[0]) + "</th><td>" + esc(p[1]) + "</td></tr>"; });
  return rows ? el("table", "kv", rows) : "";
}
function grid(head, rows) {
  if (!rows.length) return "";
  var cells = function (r, t) { return "<tr>" + r.map(function (c) { return "<" + t + ">" + esc(c) + "</" + t + ">"; }).join("") + "</tr>"; };
  return el("table", "", cells(head, "th") + rows.map(function (r) { return cells(r, "td"); }).join(""));
}
function pre(text) { return el("pre", "", esc(text)); }
function bullets(items) { var a = arr(items); return a.length ? el("ul", "", a.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("")) : ""; }
function scalars(d, skip) {
  return kv(Object.keys(d).filter(function (k) { return skip.indexOf(k) < 0 && !(d[k] !== null && typeof d[k] === "object"); })
    .map(function (k) { return [k, d[k]]; }));
}
function rest(d, skip) {
  var o = {}, n = 0;
  Object.keys(d).forEach(function (k) { if (skip.indexOf(k) < 0 && d[k] !== null && typeof d[k] === "object") { o[k] = d[k]; n++; } });
  return n ? el("details", "", "<summary>Details</summary>" + pre(JSON.stringify(o, null, 2))) : "";
}
function generic(d) { return scalars(d, []) + rest(d, []); }
function notes(d) {
  return sec("Caveats", bullets(d.caveats)) +
    sec("Unreadable", grid(["table", "status", "reason"], arr(d.unreadable).map(function (u) { return [u.table, u.status, u.reason]; })));
}
function show(v) { return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v); }

var PLAN = ["mode", "action", "table", "sys_id", "before", "after", "plan_token", "plan_token_expires_at", "note"];
function renderPlan(d) {
  var b = isObj(d.before) ? d.before : null, a = isObj(d.after) ? d.after : null, keys = Object.keys(a || b || {}).sort();
  var rows = keys.map(function (k) {
    var x = b && k in b ? show(b[k]) : "", y = a && k in a ? show(a[k]) : "";
    var cls = !a ? "del" : !b || !(k in b) ? "add" : x !== y ? "chg" : "";
    return "<tr" + (cls ? ' class="' + cls + '"' : "") + "><th>" + esc(k) + "</th><td>" + esc(x) + "</td><td>" + esc(y) + "</td></tr>";
  }).join("");
  /* A before/after that is not a record object (a list, a string) is shown as is. */
  var skip = PLAN.filter(function (k) { return !(k === "before" && !b || k === "after" && !a); });
  return kv([["mode", d.mode], ["action", d.action], ["table", d.table], ["sys_id", d.sys_id],
      ["plan_token", d.plan_token], ["expires", d.plan_token_expires_at]]) +
    sec("Changes", rows ? el("table", "", "<tr><th>field</th><th>before</th><th>after</th></tr>" + rows) : "") +
    (has(d.note) ? el("p", "dim", esc(d.note)) : "") + scalars(d, skip) + rest(d, skip);
}

var SHAPE = /([A-Za-z_][\w-]*)\s*(?:\[\/|\[\(|\(\(|\[\[|\[|\(|\{\{|\{|>)"([^"]*)"/g;
var SHAPES = /(?:\[\/|\[\(|\(\(|\[\[|\[|\(|\{\{|\{|>)"[^"]*"(?:\/\]|\)\]|\)\)|\]\]|\]|\)|\}\}|\})/g;
function parseMermaid(src) {
  var lines = String(src).split(/\r?\n/), type = (lines[0] || "").trim().split(/\s+/)[0];
  var labels = {}, edges = [], ents = {}, cur = null;
  lines.slice(1).forEach(function (raw) {
    var line = raw.replace(/%%.*$/, "").trim(), m;
    if (!line) return;
    if (type === "erDiagram") {
      if (cur !== null) {
        if (line === "}") cur = null;
        else if ((m = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?/.exec(line))) ents[cur].push([m[2], m[1], m[3] || "", m[4] || ""]);
      } else if ((m = /^([\w-]+)\s*\{$/.exec(line))) ents[cur = m[1]] = [];
      else if ((m = /^([\w-]+)\s+(\S+)\s+([\w-]+)\s*:\s*"?([^"]*)"?$/.exec(line))) edges.push([m[1], m[4], m[3]]);
      return;
    }
    SHAPE.lastIndex = 0;
    while ((m = SHAPE.exec(line))) labels[m[1]] = m[2];
    m = /^([\w-]+)\s*(-->|-\.->|==>|---|-\.-)\s*(?:\|"?([^|"]*)"?\|)?\s*([\w-]+)$/.exec(line.replace(SHAPES, ""));
    if (m) edges.push([m[1], m[3] || "", m[4]]);
  });
  return { type: type, labels: labels, edges: edges, entities: ents };
}
function renderMermaid(d) {
  if (typeof d.mermaid !== "string") return generic(d);
  var g = parseMermaid(d.mermaid);
  var name = function (id) { return has(g.labels[id]) ? g.labels[id] : id; };
  var ents = Object.keys(g.entities).map(function (k) {
    return el("details", "", "<summary>" + esc(k + " (" + g.entities[k].length + ")") + "</summary>" +
      grid(["column", "type", "key", "comment"], g.entities[k]));
  }).join("");
  return kv([["diagram", g.type]]) + scalars(d, ["mermaid"]) +
    sec("Entities", ents) +
    sec("Edges (" + g.edges.length + ")", grid(["from", "label", "to"], g.edges.map(function (e) { return [name(e[0]), e[1], name(e[2])]; }))) +
    sec("Mermaid source", pre(d.mermaid)) + rest(d, ["mermaid"]);
}

function stepTree(steps, depth) {
  var a = arr(steps);
  if (!a.length || depth > 12) return "";
  return el("ul", "", a.map(function (s) {
    var c = s.callee;
    return "<li>" + el("b", "", esc(s.number)) + " " + el("span", "tag", esc(s.kind)) + " " + esc(s.name) +
      (s.ref && has(s.ref.name) && s.ref.name !== s.name ? el("span", "dim", " → " + esc(s.ref.name)) : "") +
      (has(s.comment) ? el("div", "dim", esc(s.comment)) : "") +
      (c ? el("div", "dim", esc("calls " + c.kind + " " + (c.name || c.sys_id) + (c.cycle ? " (cycle)" : ""))) + stepTree(c.steps, depth + 1) : "") +
      stepTree(s.children, depth + 1) + "</li>";
  }).join(""));
}
function vars(list) {
  return grid(["name", "label", "type", "mandatory"], arr(list).map(function (v) { return [v.element, v.label, v.type, v.mandatory ? "yes" : ""]; }));
}
function words(parts) { return parts.filter(has).join(" "); }
function renderFlow(d) {
  if (typeof d.mermaid === "string" && !d.steps && !d.activities && !d.lanes) return renderMermaid(d);
  var h = d.flow || d.action || d.workflow || d.playbook || {}, t = d.trigger, names = {};
  arr(d.activities).forEach(function (a) { names[a.sys_id] = a.name; });
  return kv([["kind", d.kind], ["name", h.name || d.name], ["internal name", h.internal_name], ["sys_id", h.sys_id || d.sys_id],
      ["status", h.status], ["active", h.active], ["table", h.table], ["description", h.description]]) +
    sec("Trigger", isObj(t) ? kv([["type", t.type || (t.definition && t.definition.name)], ["table", t.table], ["condition", t.condition]]) : "") +
    sec("Steps", stepTree(d.steps, 0)) +
    sec("Inputs", vars(d.inputs)) + sec("Outputs", vars(d.outputs)) + sec("Variables", vars(d.variables)) +
    sec("Activities", grid(["order", "name", "definition"], arr(d.activities).map(function (a) { return [a.order, a.name, a.definition && a.definition.name]; }))) +
    sec("Transitions", grid(["from", "to", "condition"], arr(d.transitions).map(function (x) {
      return [names[x.from] || x.from, names[x.to] || x.to, x.condition && (x.condition.name || x.condition.sys_id)];
    }))) +
    sec("Lanes", arr(d.lanes).length ? el("ul", "", d.lanes.map(function (l) {
      return "<li>" + esc(words([l.number, l.name])) + (has(l.condition) ? el("div", "dim", esc(l.condition)) : "") +
        bullets(arr(l.activities).map(function (a) { return words([a.number, a.name]); })) + "</li>";
    }).join("")) : "") +
    sec("Stages", bullets(arr(d.stages).map(function (s) { return s.label; }))) +
    sec("Recent runs", grid(["name", "state", "started", "ended"], arr(d.runs).map(function (r) { return [r.name, r.state, r.started, r.ended]; }))) +
    sec("Counts", isObj(d.counts) ? scalars(d.counts, []) : "") +
    (typeof d.mermaid === "string" ? sec("Mermaid source", pre(d.mermaid)) : "") + notes(d);
}

function compTree(els, depth) {
  var a = arr(els);
  if (!a.length || depth > 30) return "";
  return el("ul", "", a.map(function (e) {
    return "<li>" + esc(e.label || e.elementId) + " " + el("span", "tag", esc(e.type)) + el("span", "dim", " " + esc(e.component) + (e.hidden ? " (hidden)" : "")) +
      arr(e.slots).map(function (s) { return el("div", "dim", esc("slot " + s.name)) + compTree(s.elements, depth + 1); }).join("") + "</li>";
  }).join(""));
}
function macro(m) {
  var c = m.composition || {}, dt = m.data || {}, tree = c.decoded && isObj(c.value) ? c.value : null;
  return kv([["macroponent", m.name || m.sys_id], ["category", m.category]]) +
    (tree ? compTree(tree.elements, 0) + (tree.omitted ? el("div", "dim", esc(tree.omitted + " element(s) omitted")) : "")
      : has(c.reason) ? el("div", "dim", esc("composition: " + c.reason)) : "") +
    (dt.decoded && arr(dt.value).length ? el("div", "dim", "data resources") +
      grid(["element", "label", "type", "broker"], dt.value.map(function (r) { return [r.elementId, r.label, r.type, r.broker]; })) : "");
}
function renderUib(d) {
  if (!Array.isArray(d.routes)) return typeof d.mermaid === "string" ? renderMermaid(d) : generic(d);
  var byId = {}, used = {}, x = d.experience || {}, cfg = d.appConfig || {};
  arr(d.macroponents).forEach(function (m) { byId[m.sys_id] = m; });
  var open = function (title, m) { used[m.sys_id] = 1; return el("details", "", "<summary>" + esc(title) + "</summary>" + macro(m)); };
  var shell = byId[x.root_macroponent];
  var routes = d.routes.map(function (r) {
    return "<li>" + el("b", "", esc(r.name || r.sys_id)) + el("span", "dim", " " + esc(words([r.route_type, r.screen_type]))) +
      el("ul", "", arr(r.screens).map(function (s) {
        var m = byId[s.macroponent], title = words([s.name || s.sys_id, has(s.applicability) ? "(" + s.applicability + ")" : ""]);
        return "<li>" + (m ? open(title, m) : esc(title) + el("span", "dim", " " + esc(s.macroponent))) + "</li>";
      }).join("")) + "</li>";
  }).join("");
  var others = arr(d.macroponents).filter(function (m) { return !used[m.sys_id] && m !== shell; });
  return kv([["experience", x.title || x.sys_id], ["path", x.path], ["landing path", cfg.landing_path]]) +
    sec("Shell", shell ? open(shell.name || shell.sys_id, shell) : "") +
    sec("Routes", routes ? el("ul", "", routes) : "") +
    sec("Other macroponents", others.map(function (m) { return open(m.name || m.sys_id, m); }).join("")) +
    sec("Data brokers", grid(["name", "table", "ACLs"], arr(d.dataBrokers).map(function (b) { return [b.name || b.sys_id, b.table, arr(b.acls).length]; }))) +
    sec("Counts", isObj(d.counts) ? scalars(d.counts, []) : "") + notes(d);
}

var RENDER = { "plan-diff": renderPlan, mermaid: renderMermaid, flow: renderFlow, "uib-tree": renderUib };
function resultData(p) {
  if (isObj(p.structuredContent)) return p.structuredContent;
  var c = arr(p.content).filter(function (x) { return x && x.type === "text"; })[0];
  if (!c) return null;
  try { return JSON.parse(c.text); } catch (e) { return { text: c.text }; }
}
function render(view, p) {
  var d = resultData(isObj(p) ? p : {});
  if (!isObj(d)) return el("p", "dim", "No result to show.");
  if (p.isError) return el("p", "err", "The tool call failed.") + generic(d);
  return (RENDER[view] || generic)(d);
}

(function () {
  if (typeof document === "undefined" || typeof window === "undefined" || window.parent === window) return;
  var root = document.documentElement, app = document.getElementById("app"), view = root.getAttribute("data-view");
  function send(m) { m.jsonrpc = "2.0"; window.parent.postMessage(m, "*"); }
  function theme(ctx) { if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) root.setAttribute("data-theme", ctx.theme); }
  function paint(html) {
    app.innerHTML = html;
    send({ method: "ui/notifications/size-changed", params: { width: root.scrollWidth, height: root.scrollHeight } });
  }
  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (ev.source !== window.parent || !m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) {
      if (m.id === 1 && m.result) { theme(m.result.hostContext); send({ method: "ui/notifications/initialized", params: {} }); }
    } else if (m.method === "ui/notifications/tool-result") paint(render(view, m.params));
    else if (m.method === "ui/notifications/tool-cancelled") paint(el("p", "dim", "The tool call was cancelled."));
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.id !== undefined)
      send(m.method === "ui/resource-teardown" ? { id: m.id, result: {} } : { id: m.id, error: { code: -32601, message: "Method not found" } });
  });
  send({ id: 1, method: "ui/initialize", params: {
    appInfo: { name: "servicenow-mcp " + view, version: root.getAttribute("data-version") },
    appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
`;

const sha256 = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The view document's own policy, enforced even by a host that applies a
 * looser one: only the one inline script and style run (pinned by hash, so
 * no injected markup could add either), no network, no base/form targets and
 * no eval (no 'unsafe-eval').
 */
export const VIEW_CSP =
  `default-src 'none'; script-src ${sha256(VIEW_SCRIPT)}; style-src ${sha256(VIEW_STYLE)}; ` +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The complete, self-contained HTML document of one view. */
export function viewHtml(
  view: AppViewId,
  title: string,
  version: string,
): string {
  return (
    `<!doctype html><html lang="en" data-view="${escapeHtml(view)}" data-version="${escapeHtml(version)}">` +
    `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>${VIEW_STYLE}</style></head>` +
    `<body><main id="app"><p class="dim">Waiting for the tool result…</p></main>` +
    `<script>${VIEW_SCRIPT}</script></body></html>`
  );
}
