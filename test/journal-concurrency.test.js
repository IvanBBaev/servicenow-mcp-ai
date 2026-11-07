// N-109 (AR-I3): the journal lock (two processes on one profile), the lazy
// Markdown mirror, the newest-first entry lookup and SN_JOURNAL_KEEP
// retention with its anchor.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appendWriteJournal,
  findWriteJournalEntry,
  flushJournalMirror,
  readWriteJournal,
} from "../build/core/write-journal.js";
import { setLogSink } from "../build/core/logging.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const journalModule = pathToFileURL(
  path.join(root, "build", "core", "write-journal.js"),
).href;

// A throwaway HMAC key, generated per run.
const KEY = randomBytes(32).toString("hex");

async function inDocsDir(env, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-n109b-"));
  freshRuntime();
  try {
    await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    freshRuntime();
    rmSync(dir, { recursive: true, force: true });
  }
}

const profileDir = (dir) => path.join(dir, "default");
const rotated = (dir) =>
  readdirSync(profileDir(dir)).filter((f) =>
    /^write-journal\..+\.jsonl$/.test(f),
  );

function runWriter(docsDir, count, tag) {
  const script = `
    const { appendWriteJournal } = await import(${JSON.stringify(journalModule)});
    for (let i = 0; i < ${count}; i++) {
      appendWriteJournal({ action: "create", table: "${tag}", sys_id: String(i) });
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        // HOME points at the temp dir, so no developer config is read.
        env: { PATH: process.env.PATH, HOME: docsDir, SN_DOCS_DIR: docsDir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(stderr)),
    );
  });
}

test("two processes appending to one profile keep a single valid chain", async () => {
  await inDocsDir({}, async (dir) => {
    const logs = await Promise.all([
      runWriter(dir, 40, "a"),
      runWriter(dir, 40, "b"),
    ]);
    assert.ok(
      logs.every((l) => !l.includes("append failed")),
      logs.join("\n"),
    );
    const { entries, integrity } = readWriteJournal();
    assert.equal(integrity, "ok");
    assert.equal(entries.length, 80);
    assert.equal(entries.filter((e) => e.table === "a").length, 40);
    assert.ok(!existsSync(path.join(profileDir(dir), "write-journal.lock")));
  });
});

test("a lock left by a dead process or an old lock file is taken over", async () => {
  await inDocsDir({}, async (dir) => {
    mkdirSync(profileDir(dir), { recursive: true });
    const lock = path.join(profileDir(dir), "write-journal.lock");
    // A PID that has exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, String(dead));
    appendWriteJournal({ action: "create", table: "t1" });
    assert.ok(!existsSync(lock));

    // A live PID (this process), but a lock file far older than any append.
    writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    appendWriteJournal({ action: "create", table: "t2" });
    const { entries, integrity } = readWriteJournal();
    assert.equal(integrity, "ok");
    assert.deepEqual(
      entries.map((e) => e.table),
      ["t1", "t2"],
    );
  });
});

test("the Markdown mirror is rendered at most once per interval", async () => {
  await inDocsDir({}, async (dir) => {
    const md = () =>
      readFileSync(path.join(profileDir(dir), "write-journal.md"), "utf8")
        .split("\n")
        .filter((l) => /^\| 20/.test(l)).length;
    appendWriteJournal({ action: "create", table: "first" });
    assert.equal(md(), 1);
    appendWriteJournal({ action: "create", table: "second" });
    appendWriteJournal({ action: "create", table: "third" });
    assert.equal(md(), 1); // pending, not rendered per line
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(md(), 3); // the timer rendered the burst once
    appendWriteJournal({ action: "create", table: "fourth" });
    assert.equal(md(), 3); // within the interval of that render: pending
    flushJournalMirror();
    assert.equal(md(), 4);
  });
});

test("findWriteJournalEntry reads newest first, stops at the entry and verifies the lines after it", async () => {
  await inDocsDir({ SN_JOURNAL_KEY: KEY }, async (dir) => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(appendWriteJournal({ action: "create", table: `t${i}` }).id);
    }
    const hit = findWriteJournalEntry(ids[2]);
    assert.equal(hit.integrity, "ok");
    assert.equal(hit.entry.table, "t2");
    assert.deepEqual(
      hit.later.map((e) => e.table),
      ["t3", "t4"],
    );
    const miss = findWriteJournalEntry("01NOPE");
    assert.equal(miss.entry, undefined);
    assert.equal(miss.integrity, "ok");

    // An edit between the entry and the head: the full check names the line.
    const file = path.join(profileDir(dir), "write-journal.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"table":"t3"', '"table":"tX"'),
    );
    const broken = findWriteJournalEntry(ids[2]);
    assert.equal(broken.integrity, "broken@5");
    assert.equal(broken.entry.table, "t2");
  });
});

test("findWriteJournalEntry checks the head HMAC and an unkeyed line after keyed ones", async () => {
  await inDocsDir({}, async (dir) => {
    let first;
    await withEnv({ SN_JOURNAL_KEY: KEY }, () => {
      first = appendWriteJournal({ action: "create", table: "k" }).id;
    });
    appendWriteJournal({ action: "create", table: "plain" });
    await withEnv({ SN_JOURNAL_KEY: KEY }, () => {
      assert.equal(findWriteJournalEntry(first).integrity, "broken@2");
    });
    // A head MAC that does not match.
    rmSync(path.join(profileDir(dir), "write-journal.head.mac"));
    await withEnv({ SN_JOURNAL_KEY: KEY }, () => {
      const id = appendWriteJournal({ action: "create", table: "k2" }).id;
      writeFileSync(
        path.join(profileDir(dir), "write-journal.head.mac"),
        "0".repeat(64),
      );
      assert.match(findWriteJournalEntry(id).integrity, /^broken@/);
    });
  });
});

test("SN_JOURNAL_KEEP removes the oldest rotated files and anchors the chain", async () => {
  const events = [];
  setLogSink((level, message, fields) => {
    if (message === "audit" && fields.event.action === "journal_retention")
      events.push({ ts: new Date().toISOString(), level, message, ...fields });
  });
  try {
    await inDocsDir(
      {
        SN_JOURNAL_MAX_BYTES: "200",
        SN_JOURNAL_KEEP: "2",
        SN_JOURNAL_KEY: KEY,
      },
      async (dir) => {
        for (let i = 0; i < 6; i++) {
          appendWriteJournal({ action: "create", table: `t${i}` });
        }
        assert.equal(rotated(dir).length, 2);
        const read = readWriteJournal();
        assert.equal(read.integrity, "ok");
        assert.deepEqual(
          read.entries.map((e) => e.table),
          ["t3", "t4", "t5"],
        );
        const anchorFile = path.join(profileDir(dir), "write-journal.anchor");
        const anchor = JSON.parse(readFileSync(anchorFile, "utf8"));
        assert.equal(anchor.removed.length, 1);
        assert.match(anchor.mac, /^[0-9a-f]{64}$/);

        // A plain anchor (the key's MAC dropped) no longer verifies.
        writeFileSync(
          anchorFile,
          JSON.stringify({ ...anchor, mac: undefined }) + "\n",
        );
        assert.equal(readWriteJournal().integrity, "broken@1");
        // A removed anchor breaks the oldest kept line, too.
        rmSync(anchorFile);
        assert.equal(readWriteJournal().integrity, "broken@1");
        writeFileSync(anchorFile, "not json");
        assert.equal(readWriteJournal().integrity, "broken@1");
      },
    );
  } finally {
    setLogSink(null);
  }
  assert.equal(events.length, 3);
  const schema = JSON.parse(
    readFileSync(
      path.join(root, "test", "fixtures", "audit-event.schema.json"),
      "utf8",
    ),
  );
  const validate = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
  }).compile(schema);
  for (const event of events) {
    assert.ok(validate(event), JSON.stringify(validate.errors));
  }
});

test("SN_JOURNAL_KEEP=0 keeps every rotated file and writes no anchor", async () => {
  await inDocsDir({ SN_JOURNAL_MAX_BYTES: "200" }, async (dir) => {
    for (let i = 0; i < 4; i++) {
      appendWriteJournal({ action: "create", table: `t${i}` });
    }
    assert.equal(rotated(dir).length, 3);
    assert.ok(!existsSync(path.join(profileDir(dir), "write-journal.anchor")));
    assert.equal(readWriteJournal().integrity, "ok");
  });
});
