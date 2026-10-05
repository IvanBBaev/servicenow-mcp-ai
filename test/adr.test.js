// N-44: project/adr/ lint — file names, header fields, the README index,
// relative links, and the decided-gate rule (every accepted ADR that settles a
// numbered owner gate is linked from that gate's line in ROADMAP-V3.md).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ADR_DIR = resolve("project/adr");
const ROADMAP_MD = resolve("project/ROADMAP-V3.md");
const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const files = readdirSync(ADR_DIR).filter(
  (f) => f.endsWith(".md") && f !== "README.md",
);
const adrs = files
  .filter((f) => f !== "0000-template.md")
  .map((file) => {
    const text = readFileSync(join(ADR_DIR, file), "utf8");
    const field = (name) =>
      text.match(new RegExp(`^- \\*\\*${name}:\\*\\* (.+)$`, "m"))?.[1];
    return {
      file,
      text,
      status: field("Status"),
      date: field("Date"),
      gate: field("Owner gate / ID"),
    };
  });

test("ADR files are named NNNN-kebab-title.md with unique numbers", () => {
  assert.ok(adrs.length > 0, "no ADRs found");
  const numbers = new Set();
  for (const f of files) {
    const m = f.match(NAME);
    assert.ok(m, `${f}: not NNNN-kebab-title.md`);
    assert.ok(!numbers.has(m[1]), `${f}: duplicate number ${m[1]}`);
    numbers.add(m[1]);
  }
});

test("each ADR starts with its number and has Status, Date and gate fields", () => {
  for (const adr of adrs) {
    const number = adr.file.slice(0, 4);
    assert.match(adr.text, new RegExp(`^# ${number} — `), adr.file);
    assert.match(
      adr.status ?? "",
      /^(proposed|accepted|superseded|rejected)\b/,
      `${adr.file}: Status`,
    );
    assert.match(adr.date ?? "", /^\d{4}-\d{2}-\d{2}\b/, `${adr.file}: Date`);
    assert.ok(adr.gate, `${adr.file}: Owner gate / ID`);
  }
});

test("the README index lists every ADR", () => {
  const readme = readFileSync(join(ADR_DIR, "README.md"), "utf8");
  for (const adr of adrs) {
    assert.ok(
      readme.includes(`(${adr.file})`),
      `${adr.file}: missing from project/adr/README.md`,
    );
  }
});

test("relative links in project/adr/ resolve", () => {
  for (const file of [...files, "README.md"]) {
    const text = readFileSync(join(ADR_DIR, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      const path = resolve(ADR_DIR, decodeURI(target.split("#")[0]));
      assert.ok(existsSync(path), `${file}: broken link ${target}`);
    }
  }
});

test("accepted gate ADRs are linked from their ROADMAP-V3.md gate line", () => {
  const roadmap = readFileSync(ROADMAP_MD, "utf8");
  const gateBlock = (gate) => {
    // A gate line may cover a range ("O-5…O-9"); continuation lines are indented.
    const lines = roadmap.split("\n");
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- \[[ x]\] \*\*O-(\d+)(?:…O-(\d+))?\*\*/);
      if (!m) continue;
      const lo = Number(m[1]);
      const hi = Number(m[2] ?? m[1]);
      if (gate < lo || gate > hi) continue;
      let block = lines[i];
      for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) {
        block += `\n${lines[j]}`;
      }
      blocks.push(block);
    }
    return blocks.join("\n");
  };
  let checked = 0;
  for (const adr of adrs) {
    if (!adr.status.startsWith("accepted")) continue;
    const gate = adr.gate.match(/^O-(\d+)\b/);
    if (!gate) continue;
    const block = gateBlock(Number(gate[1]));
    assert.ok(block, `${adr.file}: no O-${gate[1]} line in ROADMAP-V3.md`);
    assert.ok(
      block.includes(`(adr/${adr.file})`),
      `${adr.file}: not linked from the O-${gate[1]} gate line`,
    );
    checked++;
  }
  assert.ok(checked > 0, "no accepted gate ADRs checked");
});

test("ROADMAP-V3.md links into project/adr/ resolve", () => {
  const roadmap = readFileSync(ROADMAP_MD, "utf8");
  for (const [, target] of roadmap.matchAll(/\]\((adr\/[^)\s#]+)/g)) {
    assert.ok(
      existsSync(resolve(dirname(ROADMAP_MD), target)),
      `ROADMAP-V3.md: broken link ${target}`,
    );
  }
});
