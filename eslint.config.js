import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

// N-87: a bare `catch {` that does not rethrow swallows the failure on
// purpose, and the purpose has to be written down — the block carries a
// `// swallowed: <why>` comment. A `catch (error)` is free to log or narrow,
// and a block that rethrows needs no note.
const swallowedCatch = {
  meta: {
    type: "suggestion",
    docs: {
      description: "a bare catch that swallows must say why (`// swallowed:`)",
    },
    schema: [],
    messages: {
      missing:
        "A bare `catch {` that does not rethrow must explain itself with a `// swallowed: <reason>` comment inside the block.",
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        if (node.param) return;
        if (node.body.body.some((s) => s.type === "ThrowStatement")) return;
        const comments = context.sourceCode.getCommentsInside(node.body);
        if (comments.some((c) => /^\s*swallowed:/.test(c.value))) return;
        context.report({ node, messageId: "missing" });
      },
    };
  },
};

export default tseslint.config(
  // docs/ holds the hand-authored GitHub Pages site (browser JS/CSS/HTML) and
  // the runtime self-documentation store — neither is part of the Node/TS
  // project, so they stay out of the project lint (the site has its own concerns).
  // D-7: the VS Code extension's sources are linted here too (see the
  // extension/src block below); only its build output and deps are ignored.
  {
    ignores: [
      "build/",
      "node_modules/",
      "docs/",
      "extension/out/",
      "extension/node_modules/",
      // Local agent worktrees are full repo copies on other branches.
      ".claude/",
    ],
  },
  js.configs.recommended,
  // Type-checked rules need a TS program; scope them to src/ so plain-JS
  // config and test files stay on the syntax-only ruleset.
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { local: { rules: { "swallowed-catch": swallowedCatch } } },
    rules: {
      // The one we are really after: a forgotten await in an async tool
      // handler silently drops errors.
      "@typescript-eslint/no-floating-promises": "error",
      "local/swallowed-catch": "error",
      // E-7: no-unsafe-assignment / no-unsafe-member-access are on (the
      // recommendedTypeChecked default): untyped JSON is unwrapped as
      // `unknown` and narrowed, never as `any`.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  // N-87: every error the server raises on purpose carries an M-2 code, so a
  // tool result can name who failed and how to fix it — a plain `Error` under
  // the four layers is a contract gap. The CLI entry points (cli.ts,
  // migrate*.ts) print to a terminal and keep plain errors.
  {
    files: [
      "src/api/**/*.ts",
      "src/mcp/**/*.ts",
      "src/tools/**/*.ts",
      "src/core/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
          message:
            "Throw a ServiceNowError (core/errors.ts) with a code, not a plain Error.",
        },
      ],
    },
  },
  // Layer boundaries (M-2): core ← api ← mcp ← tools, enforced at lint time.
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api/**", "**/mcp/**", "**/tools/**"],
              message:
                "core is layer 0 — it must not import api/, mcp/ or tools/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/mcp/**", "**/tools/**"],
              message: "api is layer 1 — it must not import mcp/ or tools/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/tools/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/http*"],
              message:
                "tools go through the api/ layer; do not call core/http directly.",
            },
          ],
        },
      ],
    },
  },
  // D-7: the VS Code extension has its own tsconfig and its `@types/vscode`
  // lives in extension/node_modules (not installed by the root CI job). E-2:
  // ESLint 10 lints each file with its nearest config, so extension/ files use
  // extension/eslint.config.mjs (type-aware); the root `npm run lint` skips
  // extension/ and the CI extension job lints it. This block stays as the
  // syntax-only fallback should the extension config ever be removed.
  {
    files: ["extension/src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [...tseslint.configs.recommended],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
      // E-2: typescript-eslint 8.5x+ refuses to guess the root when it sees
      // two tsconfig roots (here and extension/), even for syntax-only files.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  prettier,
);
