// servicenow-mcp-ai docs — small progressive-enhancement script, no dependencies.
(function () {
  "use strict";

  /* ---- Mobile sidebar ---- */
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("backdrop");
  var menuBtn = document.getElementById("menuBtn");
  function closeMenu() {
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("show");
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      if (!sidebar) return;
      var open = sidebar.classList.toggle("open");
      if (backdrop) backdrop.classList.toggle("show", open);
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeMenu);
  if (sidebar) {
    sidebar.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "A") closeMenu();
    });
  }

  /* ---- Back-to-top button ---- */
  var toTop = document.getElementById("toTop");
  if (toTop) {
    window.addEventListener(
      "scroll",
      function () {
        toTop.classList.toggle("show", window.scrollY > 700);
      },
      { passive: true },
    );
    toTop.addEventListener("click", function () {
      var reduce =
        window.matchMedia &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
  }

  /* ---- Accessibility: mark table header cells as column scope ---- */
  document.querySelectorAll("thead th").forEach(function (th) {
    th.setAttribute("scope", "col");
  });

  /* ---- Copy buttons + language labels on code blocks ---- */
  document.querySelectorAll(".codeblock").forEach(function (block) {
    var lang = block.getAttribute("data-lang");
    if (lang) {
      var tag = document.createElement("span");
      tag.className = "lang";
      tag.textContent = lang;
      block.appendChild(tag);
    }
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var code = block.querySelector("code");
      var text = code ? code.innerText : "";
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () {
          btn.textContent = "Copy";
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (e) {
          /* ignore */
        }
        document.body.removeChild(ta);
        done();
      }
    });
    block.appendChild(btn);
  });

  /* ---- Heading anchor links ---- */
  document.querySelectorAll("section[id] > h2, section[id] > h3").forEach(
    function (h) {
      var sec = h.closest("section[id]");
      if (!sec || !h.parentElement) return;
      // Only link the first heading of a section to its id.
      if (h.tagName === "H2") {
        var a = document.createElement("a");
        a.className = "anchor";
        a.href = "#" + sec.id;
        a.textContent = "#";
        a.setAttribute("aria-label", "Link to this section");
        h.appendChild(a);
      }
    },
  );

  /* ---- Scrollspy: highlight the active sidebar link ---- */
  var links = Array.prototype.slice.call(
    document.querySelectorAll(".sidebar nav a"),
  );
  var byId = {};
  links.forEach(function (a) {
    var id = a.getAttribute("href");
    if (id && id.charAt(0) === "#") byId[id.slice(1)] = a;
  });
  var sections = links
    .map(function (a) {
      var id = a.getAttribute("href").slice(1);
      return document.getElementById(id);
    })
    .filter(Boolean);

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.remove("active");
      a.removeAttribute("aria-current");
    });
    if (byId[id]) {
      byId[id].classList.add("active");
      byId[id].setAttribute("aria-current", "true");
    }
  }

  // Highlight the section in the URL hash (or the first one) on load.
  var initialId = (location.hash || "").replace("#", "");
  setActive(byId[initialId] ? initialId : sections.length ? sections[0].id : "");

  if ("IntersectionObserver" in window && sections.length) {
    var visible = new Set();
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        });
        // Pick the topmost visible section.
        var best = null;
        var bestTop = Infinity;
        sections.forEach(function (s) {
          if (!visible.has(s.id)) return;
          var top = s.getBoundingClientRect().top;
          if (top < bestTop) {
            bestTop = top;
            best = s.id;
          }
        });
        if (best) setActive(best);
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 },
    );
    sections.forEach(function (s) {
      observer.observe(s);
    });
  }

  /* ---- Tools reference: expand / collapse all parameter panels ---- */
  function allToolDetails() {
    return Array.prototype.slice.call(
      document.querySelectorAll("#tools details.tool"),
    );
  }
  var expandBtn = document.getElementById("expand-all-tools");
  var collapseBtn = document.getElementById("collapse-all-tools");
  if (expandBtn) {
    expandBtn.addEventListener("click", function () {
      allToolDetails().forEach(function (d) {
        d.open = true;
      });
    });
  }
  if (collapseBtn) {
    collapseBtn.addEventListener("click", function () {
      allToolDetails().forEach(function (d) {
        d.open = false;
      });
    });
  }

  /* ---- Quick demo: "Three things" tabs ---- */
  var tabBar = document.getElementById("demo-tabs");
  if (tabBar) {
    var tabs = Array.prototype.slice.call(tabBar.querySelectorAll(".tab"));
    var panels = Array.prototype.slice.call(
      document.querySelectorAll(".tab-panel"),
    );
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var idx = tab.getAttribute("data-tab");
        tabs.forEach(function (t) {
          var on = t === tab;
          t.classList.toggle("active", on);
          t.setAttribute("aria-selected", String(on));
        });
        panels.forEach(function (p) {
          p.classList.toggle("active", p.getAttribute("data-panel") === idx);
        });
      });
    });
  }

  /* ---- Quick start: click-to-copy + client config tabs ---- */
  function copyToClipboard(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        /* ignore */
      }
      document.body.removeChild(ta);
      done();
    }
  }
  function flashCopied(btn, label) {
    btn.textContent = "copied ✓";
    btn.classList.add("copied");
    clearTimeout(btn._copyReset);
    btn._copyReset = setTimeout(function () {
      btn.textContent = label;
      btn.classList.remove("copied");
    }, 1400);
  }

  document.querySelectorAll(".qs-cmd").forEach(function (box) {
    var btn = box.querySelector(".qs-cmd-copy");
    var code = box.querySelector("code");
    if (!btn || !code) return;
    box.addEventListener("click", function () {
      copyToClipboard(code.innerText, function () {
        flashCopied(btn, "copy");
      });
    });
  });

  var clientConfig = document.getElementById("client-config");
  if (clientConfig) {
    var CONFIGS = {
      claude: {
        path: "~/Library/Application Support/Claude/claude_desktop_config.json",
        json:
          '{\n  "mcpServers": {\n    "servicenow": {\n      "command": "servicenow-mcp-ai"\n    }\n  }\n}',
      },
      vscode: {
        path: ".vscode/mcp.json",
        json:
          '{\n  "servers": {\n    "servicenow": {\n      "command": "servicenow-mcp-ai",\n      "type": "stdio"\n    }\n  }\n}',
      },
      cursor: {
        path: "~/.cursor/mcp.json",
        json:
          '{\n  "mcpServers": {\n    "servicenow": {\n      "command": "servicenow-mcp-ai"\n    }\n  }\n}',
      },
    };
    var cfgTabs = Array.prototype.slice.call(
      clientConfig.querySelectorAll(".qs-tab"),
    );
    var cfgPath = clientConfig.querySelector("[data-config-path]");
    var cfgJson = clientConfig.querySelector("[data-config-json]");
    var cfgCopy = clientConfig.querySelector(".qs-config-copy");
    var currentClient = "claude";
    function showClient(name) {
      var cfg = CONFIGS[name];
      if (!cfg) return;
      currentClient = name;
      if (cfgPath) cfgPath.textContent = "// " + cfg.path;
      if (cfgJson) cfgJson.textContent = cfg.json;
      cfgTabs.forEach(function (t) {
        var on = t.getAttribute("data-client") === name;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
      });
    }
    cfgTabs.forEach(function (t) {
      t.addEventListener("click", function () {
        showClient(t.getAttribute("data-client"));
      });
    });
    if (cfgCopy) {
      cfgCopy.addEventListener("click", function () {
        copyToClipboard(CONFIGS[currentClient].json, function () {
          flashCopied(cfgCopy, "copy config");
        });
      });
    }
  }

  /* ---- Hero terminal: live, self-typing, looping demo ----
     Progressive enhancement: the static .term-body markup is the no-JS /
     reduced-motion fallback (it already renders scenario 1 in full). When JS
     runs and motion is allowed, we take over the body and loop the scenarios:
     type a prompt → call a tool (spinner) → summary → stream rows → hold → next.
     Timings & data mirror the design handoff's "Terminal component" spec. */
  (function () {
    var term = document.querySelector(".hero-visual .terminal");
    var body = term && term.querySelector(".term-body");
    if (!body) return;
    var reduce =
      window.matchMedia &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return; // keep the static fallback fully rendered

    var SCENARIOS = [
      {
        prompt: "List the 5 most recent active incidents with their priority.",
        kind: "read",
        tool: "servicenow_query_table",
        table: "· incident",
        summary: "4 incidents (most recent first)",
        rows: [
          { left: "INC0010023 · Email outage", right: "P1", rc: "#ff6b6b" },
          { left: "INC0010019 · VPN latency", right: "P2", rc: "#febc2e" },
          { left: "INC0010014 · Printer offline", right: "P3", rc: "#5fd9a6" },
          { left: "INC0010008 · Slow login", right: "P3", rc: "#5fd9a6" },
        ],
      },
      {
        prompt: "Open a P2 change to patch the VPN gateway tonight.",
        kind: "write",
        tool: "servicenow_create_change",
        table: "· change_request",
        summary: "Created CHG0030471 — awaiting your confirm",
        rows: [
          { left: "number", right: "CHG0030471", rc: "#2ee89e" },
          { left: "risk", right: "Moderate", rc: "#febc2e" },
          { left: "state", right: "Assess", rc: "#5fb1ff" },
        ],
      },
      {
        prompt: "Where is the u_cost_center field used?",
        kind: "read",
        tool: "servicenow_where_used",
        table: "· field",
        summary: "12 references across 4 types",
        rows: [
          { left: "Business Rule · Calc cost center", right: "script", rc: "#9aa8a0" },
          { left: "ACL · cost_center.write", right: "acl", rc: "#9aa8a0" },
          { left: "UI Policy · Show cost center", right: "ui_policy", rc: "#9aa8a0" },
          { left: "Client Script · onChange CC", right: "client", rc: "#9aa8a0" },
        ],
      },
    ];

    function el(tag, cls) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    // Rebuild the body as a stable skeleton (keep the scanline overlay).
    var scan = body.querySelector(".term-scan");
    body.innerHTML = "";
    if (scan) body.appendChild(scan);

    var promptLine = el("div", "term-line");
    promptLine.style.marginBottom = "14px";
    promptLine.style.minHeight = "21px";
    promptLine.innerHTML =
      '<span class="tprompt">you →</span> <span class="ttyped"></span>' +
      '<span class="tcaret">▌</span>';
    body.appendChild(promptLine);
    var typed = promptLine.querySelector(".ttyped");
    var caret = promptLine.querySelector(".tcaret");
    caret.style.color = "var(--accent)";
    caret.style.marginLeft = "1px";
    caret.style.animation = "blink 1.1s steps(1) infinite";

    var dyn = el("div"); // tool row, summary and streamed result rows land here
    body.appendChild(dyn);

    var bottomCursor = el("div", "term-cursor");
    bottomCursor.textContent = "▌";
    bottomCursor.style.marginTop = "14px";
    bottomCursor.style.display = "none";
    bottomCursor.style.animation = "blink 1.1s steps(1) infinite";
    body.appendChild(bottomCursor);

    var timers = [];
    function later(ms, fn) {
      var t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    }
    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    // Single spinner interval; only animates while a tool is "running".
    var spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    var spinI = 0;
    var spinEl = null;
    setInterval(function () {
      if (!spinEl) return;
      spinI = (spinI + 1) % spinFrames.length;
      spinEl.textContent = spinFrames[spinI];
    }, 90);

    var cur = 0;

    function runScenario(idx) {
      clearTimers();
      cur = idx;
      spinEl = null;
      typed.textContent = "";
      caret.style.display = "";
      bottomCursor.style.display = "none";
      dyn.innerHTML = "";
      typePrompt(SCENARIOS[idx].prompt, 1);
    }

    function typePrompt(text, i) {
      if (i > text.length) {
        caret.style.display = "none";
        bottomCursor.style.display = "";
        later(520, showTool);
        return;
      }
      typed.textContent = text.slice(0, i);
      later(34, function () {
        typePrompt(text, i + 1);
      });
    }

    function showTool() {
      var sc = SCENARIOS[cur];
      var row = el("div", "term-line");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.marginBottom = "13px";
      row.innerHTML =
        '<span class="pill ' +
        (sc.kind === "read" ? "ro" : "wr") +
        '">' +
        sc.kind +
        '</span><span class="tcall">' +
        sc.tool +
        '</span><span class="tdim">' +
        sc.table +
        '</span><span class="trun"><span class="tspin"></span> running</span>';
      dyn.appendChild(row);
      var trun = row.querySelector(".trun");
      trun.style.marginLeft = "auto";
      trun.style.color = "var(--accent-strong)";
      trun.style.display = "inline-flex";
      trun.style.alignItems = "center";
      trun.style.gap = "6px";
      spinEl = row.querySelector(".tspin");
      spinEl.style.color = "var(--accent)";
      spinEl.textContent = spinFrames[0];
      later(820, showSummary);
    }

    function showSummary() {
      spinEl = null;
      var trun = dyn.querySelector(".trun");
      if (trun) trun.parentNode.removeChild(trun);
      var s = el("div", "term-line");
      s.textContent = SCENARIOS[cur].summary;
      s.style.color = "#7e8d84";
      s.style.marginBottom = "10px";
      dyn.appendChild(s);
      later(360, function () {
        streamRows(0);
      });
    }

    function streamRows(i) {
      var sc = SCENARIOS[cur];
      if (i >= sc.rows.length) {
        later(2800, function () {
          runScenario((cur + 1) % SCENARIOS.length);
        });
        return;
      }
      var r = sc.rows[i];
      var row = el("div", "term-line term-row");
      var left = el("span");
      left.textContent = r.left;
      var right = el("span");
      right.textContent = r.right;
      right.style.fontWeight = "600";
      right.style.color = r.rc;
      row.appendChild(left);
      row.appendChild(right);
      dyn.appendChild(row);
      later(250, function () {
        streamRows(i + 1);
      });
    }

    runScenario(0);
  })();

  /* ---- Tools reference: live search over the real tool registry ---- */
  var filterInput = document.getElementById("tools-filter");
  var countEl = document.getElementById("tools-count");
  var emptyEl = document.getElementById("tools-empty");
  var toolsSection = document.getElementById("tools");
  if (filterInput && toolsSection) {
    // Build an index: each tool with its searchable text and its package heading.
    var index = [];
    var currentHeading = null;
    Array.prototype.slice
      .call(toolsSection.children)
      .forEach(function (node) {
        if (node.tagName === "H3" && node.id && node.id.indexOf("pkg-") === 0) {
          currentHeading = node;
        } else if (
          node.tagName === "DETAILS" &&
          node.classList.contains("tool")
        ) {
          var nameEl = node.querySelector("summary code");
          var sumEl = node.querySelector(".tool-sum");
          var pkg = currentHeading
            ? (currentHeading.id || "").replace("pkg-", "")
            : "";
          index.push({
            el: node,
            heading: currentHeading,
            text: (
              (nameEl ? nameEl.textContent : "") +
              " " +
              (sumEl ? sumEl.textContent : "") +
              " " +
              pkg
            ).toLowerCase(),
          });
        }
      });
    var total = index.length;

    function applyFilter() {
      var q = filterInput.value.trim().toLowerCase();
      var shown = 0;
      var headingHasMatch = new Map();
      index.forEach(function (item) {
        var match = q === "" || item.text.indexOf(q) !== -1;
        item.el.hidden = !match;
        if (match) {
          shown++;
          if (item.heading) headingHasMatch.set(item.heading, true);
        }
      });
      // Hide package headings whose tools are all filtered out.
      Array.prototype.slice
        .call(toolsSection.querySelectorAll("h3[id^='pkg-']"))
        .forEach(function (h) {
          h.hidden = q !== "" && !headingHasMatch.get(h);
        });
      if (countEl) {
        countEl.textContent =
          shown === total
            ? total + " tools"
            : shown + " of " + total + " tools";
      }
      if (emptyEl) emptyEl.style.display = shown === 0 ? "block" : "none";
    }

    filterInput.addEventListener("input", applyFilter);
    applyFilter(); // initialise the counter
  }
})();
