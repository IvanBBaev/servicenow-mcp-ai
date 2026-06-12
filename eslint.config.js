import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["build/", "node_modules/"] },
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
    rules: {
      // The one we are really after: a forgotten await in an async tool
      // handler silently drops errors.
      "@typescript-eslint/no-floating-promises": "error",
      // ServiceNow payloads are untyped JSON; unwrapping them relies on
      // runtime checks, so these stay advisory rather than blocking.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  // Layer boundaries (М-2): core ← api ← mcp ← tools, enforced at lint time.
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api/**", "**/mcp/**", "**/tools/**"],
              message: "core is layer 0 — it must not import api/, mcp/ or tools/.",
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
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [...tseslint.configs.recommended],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
