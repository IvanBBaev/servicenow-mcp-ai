// N-66 — attachment file I/O: `file_path` uploads read from SN_DOCS_DIR
// (confined like every docs path, size-checked before the read, MIME by
// extension) and `format:"file"` downloads written under exports/ with a
// sha256 and a text preview, so bytes never pass through the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  guessContentType,
  isTextType,
  resolveUploadPath,
} from "../build/api/attachment.js";
import { openDocStream } from "../build/api/docs.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { PREVIEW_CHARS, writeExportBytes } from "../build/mcp/file-result.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

const DOCS_DIR = mkdtempSync(path.join(tmpdir(), "sn-n66-docs-"));
const OUTSIDE = mkdtempSync(path.join(tmpdir(), "sn-n66-outside-"));
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();

const IN = path.join(DOCS_DIR, "in");
mkdirSync(path.join(IN, "dir"), { recursive: true });
const NOTES = "hello from a file\n";
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff, 0xfe, 0x0a]);
writeFileSync(path.join(IN, "notes.txt"), NOTES);
writeFileSync(path.join(IN, "report.pdf"), PDF);
writeFileSync(path.join(IN, "README"), "no extension");
writeFileSync(path.join(IN, "data.json"), '{"a":1}');
writeFileSync(path.join(OUTSIDE, "secret.txt"), "not yours");
symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(IN, "link.txt"));

test.beforeEach(() => freshRuntime());
test.after(() => {
  rmSync(DOCS_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const upload = (args) =>
  call("servicenow_upload_attachment", {
    table: "incident",
    sys_id: "rec1",
    ...args,
  });
const noFetch = () => {
  throw new Error("fetch must not be called");
};

/** Run an upload that must be refused before any request leaves. */
async function refused(args, code, pattern) {
  await withFetch(noFetch, async (calls) => {
    for (const apply of [false, true]) {
      const res = await upload({ ...args, apply });
      assert.equal(res.isError, true, `apply=${apply} should fail`);
      const body = out(res);
      assert.equal(body.code, code, body.error);
      assert.match(body.error, pattern);
    }
    assert.equal(calls.length, 0);
  });
}

const attachmentFetch = (expect) => (url, init) => {
  const u = new URL(url);
  assert.equal(u.pathname, "/api/now/attachment/file");
  assert.equal(u.searchParams.get("table_name"), "incident");
  assert.equal(u.searchParams.get("table_sys_id"), "rec1");
  assert.equal(u.searchParams.get("file_name"), expect.fileName);
  assert.equal(init.headers["Content-Type"], expect.contentType);
  assert.ok(Buffer.from(init.body).equals(expect.bytes), "body bytes");
  return jsonResponse(201, { result: { sys_id: "att1" } });
};

test("upload from file_path sends the file bytes, its name and the guessed type, and journals the path", async () => {
  await withFetch(
    attachmentFetch({
      fileName: "notes.txt",
      contentType: "text/plain",
      bytes: Buffer.from(NOTES),
    }),
    async (calls) => {
      const res = await upload({ file_path: "in/notes.txt", apply: true });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = out(res);
      assert.equal(body.message, "Attachment uploaded");
      assert.equal(body.record.sys_id, "att1");
      assert.equal(calls.length, 1);
    },
  );
  const entry = readWriteJournal()
    .entries.filter((e) => e.action === "create" && e.table === "incident")
    .at(-1);
  assert.ok(entry, "journal entry");
  assert.equal(entry.fields.file_path, "in/notes.txt");
  assert.equal(entry.fields.file_name, "notes.txt");
  assert.equal(entry.fields.content_type, "text/plain");
});

test("upload preview from file_path shows the validated envelope and the path, never base64_chars", async () => {
  await withFetch(noFetch, async (calls) => {
    const res = await upload({ file_path: "in/notes.txt" });
    assert.equal(res.isError, undefined, res.content[0].text);
    const { after } = out(res);
    assert.equal(after.file_name, "notes.txt");
    assert.equal(after.content_type, "text/plain");
    assert.equal(after.bytes, Buffer.byteLength(NOTES));
    assert.equal(after.sha256, sha256(NOTES));
    assert.equal(after.file_path, "in/notes.txt");
    assert.equal("base64_chars" in after, false);
    assert.equal(calls.length, 0);
  });
});

test("upload from file_path: file_name and content_type override the defaults; no extension means octet-stream", async () => {
  await withFetch(
    attachmentFetch({
      fileName: "readme.md",
      contentType: "text/markdown",
      bytes: Buffer.from("no extension"),
    }),
    async () => {
      const res = await upload({
        file_path: "in/README",
        file_name: "readme.md",
        content_type: "text/markdown",
        apply: true,
      });
      assert.equal(res.isError, undefined, res.content[0].text);
    },
  );
  await withFetch(noFetch, async () => {
    const { after } = out(await upload({ file_path: "in/README" }));
    assert.equal(after.file_name, "README");
    assert.equal(after.content_type, "application/octet-stream");
  });
});

test("upload accepts an absolute file_path inside SN_DOCS_DIR and reports it docs-relative", async () => {
  await withFetch(noFetch, async () => {
    const res = await upload({
      file_path: path.join(DOCS_DIR, "in", "data.json"),
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    const { after } = out(res);
    assert.equal(after.file_path, "in/data.json");
    assert.equal(after.content_type, "application/json");
    assert.equal(after.sha256, sha256('{"a":1}'));
  });
});

test("upload refuses paths that leave SN_DOCS_DIR, lexically or through a symlink", async () => {
  await refused({ file_path: "../escape.txt" }, "INVALID_INPUT", /escapes/);
  await refused(
    { file_path: path.join(OUTSIDE, "secret.txt") },
    "INVALID_INPUT",
    /escapes the docs directory/,
  );
  await refused({ file_path: "in/link.txt" }, "INVALID_INPUT", /symbolic link/);
  await refused({ file_path: "   " }, "INVALID_INPUT", /file_path is empty/);
});

test("upload refuses a missing file, a directory and the write journal", async () => {
  await refused(
    { file_path: "in/missing.txt" },
    "INVALID_INPUT",
    /File not found: in\/missing\.txt/,
  );
  await refused({ file_path: "in/dir" }, "INVALID_INPUT", /Not a regular file/);
  await refused(
    { file_path: "default/write-journal.jsonl" },
    "INVALID_INPUT",
    /write journal cannot be uploaded/,
  );
});

test("upload from file_path honours SN_MAX_UPLOAD_BYTES on the stat and SN_UPLOAD_MIME_ALLOW", async () => {
  await withEnv({ SN_MAX_UPLOAD_BYTES: "4" }, () =>
    refused(
      { file_path: "in/notes.txt" },
      "PAYLOAD_TOO_LARGE",
      /exceeds the SN_MAX_UPLOAD_BYTES limit of 4/,
    ),
  );
  await withEnv({ SN_UPLOAD_MIME_ALLOW: "image/png" }, () =>
    refused(
      { file_path: "in/notes.txt" },
      "MIME_NOT_ALLOWED",
      /"text\/plain" is not permitted by SN_UPLOAD_MIME_ALLOW/,
    ),
  );
});

test("upload needs exactly one source, and a file_name with content_base64", async () => {
  await refused(
    { file_name: "a.txt", content_base64: "aGk=", file_path: "in/notes.txt" },
    "INVALID_INPUT",
    /exactly one of content_base64 and file_path/,
  );
  await refused({ file_name: "a.txt" }, "INVALID_INPUT", /exactly one/);
  await refused(
    { content_base64: "aGk=" },
    "INVALID_INPUT",
    /file_name is required with content_base64/,
  );
});

test("upload from content_base64 still works and journals no file_path", async () => {
  await withFetch(
    attachmentFetch({
      fileName: "a.txt",
      contentType: "text/plain",
      bytes: Buffer.from("hi"),
    }),
    async () => {
      const res = await upload({
        file_name: "a.txt",
        content_base64: "aGk=",
        content_type: "text/plain",
        apply: true,
      });
      assert.equal(res.isError, undefined, res.content[0].text);
    },
  );
  const entry = readWriteJournal()
    .entries.filter((e) => e.action === "create" && e.table === "incident")
    .at(-1);
  assert.equal(entry.fields.file_name, "a.txt");
  assert.equal("file_path" in entry.fields, false);
});

const downloadFetch =
  ({ fileName, contentType, bytes, metaType }) =>
  (url) => {
    if (/\/api\/now\/attachment\/att9$/.test(url)) {
      return jsonResponse(200, {
        result: {
          sys_id: "att9",
          file_name: fileName,
          content_type: metaType ?? contentType,
          size_bytes: String(bytes.length),
        },
      });
    }
    assert.match(url, /\/api\/now\/attachment\/att9\/file$/);
    return new Response(bytes, {
      status: 200,
      headers: contentType ? { "content-type": contentType } : {},
    });
  };

test("download format 'file' writes the exact bytes under exports/ with a sha256 and no preview for binary content", async () => {
  await withFetch(
    downloadFetch({
      fileName: "Q3 report.pdf",
      contentType: "application/pdf",
      bytes: PDF,
    }),
    async (calls) => {
      const res = await call("servicenow_download_attachment", {
        sys_id: "att9",
        format: "file",
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = out(res);
      assert.equal(body.format, "file");
      assert.equal(body.attachment_sys_id, "att9");
      assert.equal(body.file_name, "Q3 report.pdf");
      assert.equal(body.content_type, "application/pdf");
      assert.equal(body.bytes, PDF.length);
      assert.equal(body.sha256, sha256(PDF));
      assert.match(body.path, /^default\/exports\/Q3_report-[0-9TZ-]+\.pdf$/);
      assert.equal(body.file, path.join(DOCS_DIR, body.path));
      assert.ok(readFileSync(body.file).equals(PDF), "file bytes");
      assert.equal("preview" in body, false);
      assert.equal("base64" in body, false);
      assert.equal(calls.length, 2);
      const entry = readWriteJournal().entries.find(
        (e) => e.action === "local_write" && e.target === `docs/${body.path}`,
      );
      assert.ok(entry, "local_write journal entry");
    },
  );
});

test("download format 'file' previews text content, capped at PREVIEW_CHARS", async () => {
  const long = "x".repeat(PREVIEW_CHARS + 500);
  await withFetch(
    downloadFetch({
      fileName: "big.log",
      contentType: "text/plain; charset=utf-8",
      bytes: Buffer.from(long),
    }),
    async () => {
      const body = out(
        await call("servicenow_download_attachment", {
          sys_id: "att9",
          format: "file",
        }),
      );
      assert.equal(body.preview.length, PREVIEW_CHARS);
      assert.equal(body.preview_truncated, true);
      assert.equal(readFileSync(body.file, "utf8"), long);
    },
  );
  await withFetch(
    downloadFetch({
      fileName: "small.json",
      contentType: undefined,
      metaType: "application/json",
      bytes: Buffer.from('{"ok":true}'),
    }),
    async () => {
      const body = out(
        await call("servicenow_download_attachment", {
          sys_id: "att9",
          format: "file",
        }),
      );
      // No response header: the metadata's content type decides.
      assert.equal(body.content_type, "application/json");
      assert.equal(body.preview, '{"ok":true}');
      assert.equal("preview_truncated" in body, false);
    },
  );
});

test("download without format still returns base64 inline", async () => {
  await withFetch(
    downloadFetch({
      fileName: "a.txt",
      contentType: "text/plain",
      bytes: Buffer.from("hi"),
    }),
    async () => {
      const body = out(
        await call("servicenow_download_attachment", { sys_id: "att9" }),
      );
      assert.equal(Buffer.from(body.base64, "base64").toString(), "hi");
      assert.equal("path" in body, false);
    },
  );
});

test("writeExportBytes falls back to .bin without an extension and keeps a dotted stem", async () => {
  const data = new Uint8Array([1, 2, 3]);
  const noExt = await writeExportBytes("README", data);
  assert.match(noExt.path, /^default\/exports\/README-[0-9TZ-]+\.bin$/);
  assert.equal(noExt.bytes, 3);
  assert.ok(readFileSync(noExt.file).equals(Buffer.from(data)));
  const dotted = await writeExportBytes("archive.tar.gz", data);
  assert.match(dotted.path, /^default\/exports\/archive\.tar-[0-9TZ-]+\.gz$/);
  const odd = await writeExportBytes("../../etc/passwd", data);
  assert.match(odd.path, /^default\/exports\/etc_passwd-[0-9TZ-]+\.bin$/);
});

test("DocStream.write accepts raw bytes and text in any order", async () => {
  const s = await openDocStream("default/exports/mixed.bin", [".bin"]);
  await s.write(new Uint8Array([0xff, 0x00]));
  await s.write("é");
  await s.write(new Uint8Array(0));
  const { bytes, abs } = await s.close();
  assert.equal(bytes, 4);
  assert.ok(readFileSync(abs).equals(Buffer.from([0xff, 0x00, 0xc3, 0xa9])));
});

test("resolveUploadPath, guessContentType and isTextType", () => {
  assert.deepEqual(resolveUploadPath("in/report.pdf"), {
    abs: path.join(DOCS_DIR, "in", "report.pdf"),
    rel: "in/report.pdf",
  });
  // An absolute path is only accepted inside SN_DOCS_DIR — never re-rooted.
  assert.throws(() => resolveUploadPath("/in/report.pdf"), /escapes/);
  assert.throws(() => resolveUploadPath("in/a:b.txt"), /":"/);
  assert.equal(guessContentType("x.PNG"), "image/png");
  assert.equal(guessContentType("notes.md"), "text/markdown");
  assert.equal(guessContentType("x.unknown"), undefined);
  assert.equal(guessContentType("noext"), undefined);
  assert.equal(isTextType("text/plain; charset=utf-8"), true);
  assert.equal(isTextType("application/json"), true);
  assert.equal(isTextType("application/ld+json"), true);
  assert.equal(isTextType("application/vnd.ms-excel"), false);
  assert.equal(isTextType("image/png"), false);
  assert.equal(isTextType(undefined), false);
});
