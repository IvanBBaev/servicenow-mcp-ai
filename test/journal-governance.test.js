// N-109 (GV-I2): the fail-closed journal (SN_JOURNAL_REQUIRED), the keyed
// chain (SN_JOURNAL_KEY), 0600/0700 file modes, the stdio identity fields and
// the `audit` log events with their pinned JSON schema.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import {
  appendWriteJournal,
  emitAudit,
  journaledWrite,
  readWriteJournal,
  setJournalClientName,
  sha256Hex,
} from "../build/core/write-journal.js";
import { setLogSink } from "../build/core/logging.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Throwaway HMAC keys, generated per run.
const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

const tempDocsDir = () => mkdtempSync(path.join(tmpdir(), "snmcp-n109-"));

async function inDocsDir(env, fn) {
  const dir = tempDocsDir();
  freshRuntime();
  try {
    await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const journalFile = (dir) => path.join(dir, "default", "write-journal.jsonl");

test(
  "SN_JOURNAL_REQUIRED refuses an instance write before anything is sent when the journal is read-only",
  { skip: !posix || isRoot },
  async () => {
    await inDocsDir({ SN_JOURNAL_REQUIRED: "true" }, async (dir) => {
      const profileDir = path.join(dir, "default");
      mkdirSync(profileDir);
      chmodSync(profileDir, 0o500);
      let sent = false;
      try {
        await assert.rejects(
          journaledWrite({ action: "create", table: "incident" }, async () => {
            sent = true;
            return {};
          }),
          (error) =>
            error instanceof ServiceNowError &&
            error.code === "JOURNAL_UNAVAILABLE" &&
            error.status === 503,
        );
        assert.equal(sent, false, "no request may be sent");
      } finally {
        chmodSync(profileDir, 0o700);
      }
    });
  },
);

test(
  "without SN_JOURNAL_REQUIRED a read-only journal never blocks the write",
  {
    skip: !posix || isRoot,
  },
  async () => {
    await inDocsDir({}, async (dir) => {
      const profileDir = path.join(dir, "default");
      mkdirSync(profileDir);
      chmodSync(profileDir, 0o500);
      try {
        const out = await journaledWrite(
          { action: "create", table: "incident" },
          async () => ({ ok: true }),
        );
        assert.deepEqual(out, { ok: true });
      } finally {
        chmodSync(profileDir, 0o700);
      }
    });
  },
);

test("SN_JOURNAL_REQUIRED with a writable journal lets the write through", async () => {
  await inDocsDir({ SN_JOURNAL_REQUIRED: "true" }, async (dir) => {
    await journaledWrite(
      { action: "update", table: "incident", sys_id: "a" },
      async () => ({}),
    );
    assert.equal(readWriteJournal().entries.length, 1);
    assert.ok(statSync(journalFile(dir)).size > 0);
  });
});

test("SN_JOURNAL_KEY: a line edited and re-chained with plain sha256 breaks the keyed chain", async () => {
  await inDocsDir({ SN_JOURNAL_KEY: KEY_A }, async (dir) => {
    for (const sys_id of ["a", "b", "c"]) {
      appendWriteJournal({ action: "update", table: "incident", sys_id });
    }
    const keyed = readWriteJournal();
    assert.equal(keyed.integrity, "ok");
    assert.ok(keyed.entries.every((e) => typeof e.prev_mac === "string"));

    // Tamper with line 2 and re-chain every sha256 link and the head — what
    // someone without the key can do.
    const lines = readFileSync(journalFile(dir), "utf8")
      .split("\n")
      .filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    parsed[1].sys_id = "forged";
    const rechained = [];
    for (const [i, entry] of parsed.entries()) {
      if (i > 0) entry.prev = sha256Hex(rechained[i - 1]);
      rechained.push(JSON.stringify(entry));
    }
    writeFileSync(journalFile(dir), rechained.join("\n") + "\n");
    writeFileSync(
      path.join(dir, "default", "write-journal.head"),
      sha256Hex(rechained.at(-1)),
    );

    assert.equal(readWriteJournal().integrity, "broken@3");
    // Without the key the plain chain is all a reader can check — and it holds.
    await withEnv({ SN_JOURNAL_KEY: undefined }, () => {
      assert.equal(readWriteJournal().integrity, "ok");
    });
  });
});

test("SN_JOURNAL_KEY: an unkeyed line after a keyed one, or a wrong head mac, breaks", async () => {
  await inDocsDir({ SN_JOURNAL_KEY: KEY_A }, async () => {
    appendWriteJournal({ action: "create", table: "incident" });
    await withEnv({ SN_JOURNAL_KEY: undefined }, () => {
      appendWriteJournal({ action: "create", table: "incident" });
    });
    assert.equal(readWriteJournal().integrity, "broken@2");
  });
  await inDocsDir({ SN_JOURNAL_KEY: KEY_A }, async (dir) => {
    appendWriteJournal({ action: "create", table: "incident" });
    writeFileSync(
      path.join(dir, "default", "write-journal.head.mac"),
      "0".repeat(64),
    );
    assert.equal(readWriteJournal().integrity, "broken@1");
    // A different key does not verify the macs either.
    await withEnv({ SN_JOURNAL_KEY: KEY_B }, () => {
      assert.equal(readWriteJournal().integrity, "broken@1");
    });
  });
});

test(
  "journal files are 0600 in a 0700 directory, and older 0644 files are tightened",
  {
    skip: !posix,
  },
  async () => {
    await inDocsDir({}, async (dir) => {
      const profileDir = path.join(dir, "default");
      mkdirSync(profileDir, { mode: 0o755 });
      writeFileSync(path.join(profileDir, "write-journal.jsonl"), "", {
        mode: 0o644,
      });
      chmodSync(path.join(profileDir, "write-journal.jsonl"), 0o644);
      appendWriteJournal({ action: "create", table: "incident" });
      for (const f of [
        "write-journal.jsonl",
        "write-journal.head",
        "write-journal.md",
      ]) {
        assert.equal(statSync(path.join(profileDir, f)).mode & 0o777, 0o600, f);
      }
    });
    await inDocsDir({}, async (dir) => {
      appendWriteJournal({ action: "create", table: "incident" });
      assert.equal(statSync(path.join(dir, "default")).mode & 0o777, 0o700);
    });
  },
);

test("a stdio line records the OS user, the host and the MCP client", async () => {
  await inDocsDir({}, async () => {
    setJournalClientName(() => "claude-code/2.1.0");
    const entry = appendWriteJournal({ action: "create", table: "incident" });
    assert.equal(entry.client_name, "claude-code/2.1.0");
    assert.equal(typeof entry.host, "string");
    let expectedUser;
    try {
      expectedUser = userInfo().username;
    } catch {
      expectedUser = undefined;
    }
    assert.equal(entry.os_user, expectedUser);
    // A failing reader never breaks the append.
    setJournalClientName(() => {
      throw new Error("boom");
    });
    assert.equal(
      appendWriteJournal({ action: "create", table: "incident" }).client_name,
      undefined,
    );
  });
});

test("audit events match the pinned schema", async () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("./fixtures/audit-event.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const validate = new Ajv2020({
    strict: true,
    // `required` inside the if/then branches names properties declared at the top.
    strictRequired: false,
    allErrors: true,
  }).compile(schema);
  const events = [];
  setLogSink((level, message, fields) => {
    if (message === "audit")
      events.push({ ts: new Date().toISOString(), level, message, ...fields });
  });
  try {
    await inDocsDir({}, async () => {
      appendWriteJournal({ action: "delete", table: "incident", sys_id: "x" });
      emitAudit("policy_change", { package: "table", enabled: false });
      emitAudit("apply_denied", { code: "PLAN_REQUIRED" });
    });
  } finally {
    setLogSink(null);
  }
  assert.deepEqual(
    events.map((e) => e.event.action),
    ["journal", "policy_change", "apply_denied"],
  );
  for (const event of events) {
    assert.ok(validate(event), JSON.stringify(validate.errors));
  }
  assert.equal(events[0].action_kind, "delete");
  // A journal event without its required fields fails the schema.
  assert.equal(
    validate({ ...events[0], id: undefined, table: undefined }),
    false,
  );
});
