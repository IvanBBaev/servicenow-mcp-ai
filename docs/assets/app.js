// servicenow-mcp-ai docs — small progressive-enhancement script, no dependencies.
(function () {
  "use strict";

  /* ---- Theme (persisted; respects system preference on first visit) ---- */
  var root = document.documentElement;
  var themeBtn = document.getElementById("themeBtn");
  var stored = null;
  try {
    stored = localStorage.getItem("sn-theme");
  } catch (e) {
    /* private mode */
  }
  var initial =
    stored ||
    (window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  setTheme(initial);

  function setTheme(t) {
    root.setAttribute("data-theme", t);
    if (themeBtn) {
      themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
      themeBtn.setAttribute("aria-pressed", String(t === "dark"));
      themeBtn.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme";
    }
  }
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next =
        root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setTheme(next);
      try {
        localStorage.setItem("sn-theme", next);
      } catch (e) {
        /* ignore */
      }
    });
  }

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
})();
