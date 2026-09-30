// D-7: the VS Code extension's contribution manifest must stay in step with
// the server. The `servicenowMcp.packages` setting offers an enum of package
// and profile names that end up in SN_TOOL_PACKAGES, so a package added to (or
// removed from) the registry must be reflected there; every contributed
// command must be handled, and every walkthrough step's media must exist.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PACKAGES } from "../build/mcp/registry.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const ext = path.join(root, "extension");
const manifest = JSON.parse(
  readFileSync(path.join(ext, "package.json"), "utf8"),
);
const PROFILES = ["core", "all", "reader", "developer", "admin"];

test("servicenowMcp.packages offers exactly the registry packages plus the profiles", () => {
  const prop =
    manifest.contributes.configuration.properties["servicenowMcp.packages"];
  const names = prop.items.enum;
  assert.deepEqual(
    [...names].sort(),
    [...PROFILES, ...ALL_PACKAGES].sort(),
    "update extension/package.json when a tool package is added or removed",
  );
  assert.equal(new Set(names).size, names.length, "no duplicate names");
  assert.equal(prop.items.enumDescriptions.length, names.length);
});

test("every contributed command is registered by the extension", () => {
  const source = readFileSync(path.join(ext, "src", "extension.ts"), "utf8");
  for (const { command } of manifest.contributes.commands) {
    assert.ok(
      source.includes(`"${command}"`),
      `${command} is contributed but never registered`,
    );
  }
});

test("walkthrough media files exist and step commands are contributed", () => {
  const commands = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const walkthrough of manifest.contributes.walkthroughs) {
    for (const step of walkthrough.steps) {
      const media = step.media.markdown ?? step.media.image;
      assert.ok(existsSync(path.join(ext, media)), `${media} is missing`);
      for (const match of step.description.matchAll(/\(command:([\w.]+)\)/g)) {
        assert.ok(commands.has(match[1]), `${match[1]} is not contributed`);
      }
    }
  }
});

test("the extension spawns the published server package", () => {
  const config = readFileSync(path.join(ext, "src", "config.ts"), "utf8");
  const rootName = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).name;
  assert.match(
    config,
    new RegExp(`SERVER_PACKAGE = "${rootName.replace(/[-]/g, "\\-")}`),
  );
});
