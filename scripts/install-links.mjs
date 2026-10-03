// D-4: one-click install links for the README and the docs site, derived from
// package.json so the published package name can never drift from the links.
//
// The links carry only the launch command (`npx -y <package>`) and no env
// block: a real environment variable wins over the env file, so a placeholder
// SN_INSTANCE baked into a client config would shadow the user's
// ~/.config/servicenow-mcp-ai/.env. Credentials belong in that env file,
// `npx servicenow-mcp-ai login` (OAuth) or the servicenow_set_credentials tool.
//
// test/install-links.test.js asserts README.md and docs/index.html contain
// exactly these strings. After a change, run `node scripts/install-links.mjs`
// and paste the printed links into both files.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The MCP server key every snippet uses (matches .claude-plugin/plugin.json). */
export const SERVER_NAME = "servicenow";

/** The stdio launch config shared by every client: `npx -y <package>`. */
export function serverConfig(pkg) {
  return { command: "npx", args: ["-y", pkg.name] };
}

/**
 * Builds every generated install string from a parsed package.json.
 * @param {{ name: string }} pkg
 */
export function installLinks(pkg) {
  const config = serverConfig(pkg);
  // VS Code takes the name inside the JSON (`code --add-mcp`, `vscode:mcp/install`).
  const vscodeJson = JSON.stringify({ name: SERVER_NAME, ...config });
  const vscode = `vscode:mcp/install?${encodeURIComponent(vscodeJson)}`;
  const vscodeInsiders = `vscode-insiders:mcp/install?${encodeURIComponent(vscodeJson)}`;
  // Cursor takes the name as a query parameter and the config as base64 JSON.
  const cursorConfig = encodeURIComponent(
    Buffer.from(JSON.stringify(config), "utf8").toString("base64"),
  );
  const cursorQuery = `name=${encodeURIComponent(SERVER_NAME)}&config=${cursorConfig}`;
  return {
    vscodeJson,
    vscode,
    vscodeInsiders,
    // GitHub strips non-http(s) hrefs, so README buttons go through the
    // vscode.dev redirector, which opens the wrapped deeplink.
    vscodeWeb: `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(vscode)}`,
    vscodeInsidersWeb: `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(vscodeInsiders)}`,
    codeAddMcp: `code --add-mcp '${vscodeJson}'`,
    codeInsidersAddMcp: `code-insiders --add-mcp '${vscodeJson}'`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?${cursorQuery}`,
    cursorWeb: `https://cursor.com/en/install-mcp?${cursorQuery}`,
  };
}

/**
 * Escapes a generated string for docs/index.html (href attribute or <code>
 * text). Quotes stay literal: the links carry none and <code> text needs none.
 */
export function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const root = path.join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const [key, value] of Object.entries(installLinks(pkg))) {
    console.log(`${key}:\n  ${value}\n  html: ${htmlEscape(value)}\n`);
  }
}
