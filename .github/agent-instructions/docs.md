---
applyTo:
  - "docs/**"
---

# docs — the public GitHub Pages site

- `docs/` is published as the project site: `index.html`, `llms.txt`,
  `robots.txt`, `sitemap.xml`, `assets/`. Never put internal notes here.
- `index.html` is hand-written and Prettier-ignored, but its tool counts are
  kept by `npm run docs:sync`, its version by `scripts/sync-version.mjs`, and
  its install links come from `scripts/install-links.mjs`
  (`test/install-links.test.js`).
- `docs/instance/` is the default runtime documentation store (`SN_DOCS_DIR`),
  not site content.
- `docs/ai/` is a local-only harness path: never create or commit files there.
