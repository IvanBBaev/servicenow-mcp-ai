// E-6: lint for the VS Code extension with type information. The extension
// package carries no lint dependencies of its own — `@eslint/js`,
// `typescript-eslint`, `eslint-config-prettier` and `globals` resolve from the
// repository root's node_modules (the CI extension job installs both).
// `@types/vscode` comes from extension/node_modules through this tsconfig.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["out/", "node_modules/"] },
  js.configs.recommended,
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
      // Same intent as the server: a forgotten await in a command handler
      // silently drops errors. Top-level node:test registrations are the one
      // known-safe exception (the runner awaits them).
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "it", "describe", "suite"],
            },
          ],
        },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [...tseslint.configs.recommended],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
