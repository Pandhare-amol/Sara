import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentVerifier } from "../src/core/tools/verification/documentVerifier";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sara-document-verify-"));
  return { dir, path: join(dir, "draft.txt"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function evidence(path: string, contents: string) {
  return { data: { result: { path, verified: true, sha256: createHash("sha256").update(contents).digest("hex") } } };
}

test("document verifier independently reads created text instead of trusting a reported success", async () => {
  const store = fixture();
  try {
    writeFileSync(store.path, "Actual text", "utf8");
    const verifier = new DocumentVerifier(async () => ({ ok: false }));
    const verified = await verifier.verify("saraDocumentCreate", { path: store.path, text: "Actual text" }, evidence(store.path, "Actual text"));
    assert.equal(verified.verified, true);
    const mismatch = await verifier.verify("saraDocumentCreate", { path: store.path, text: "Different" }, evidence(store.path, "Actual text"));
    assert.equal(mismatch.verified, false);
    const forged = await verifier.verify("saraDocumentCreate", { path: store.path, text: "Actual text" }, evidence(join(store.dir, "wrong.txt"), "Actual text"));
    assert.equal(forged.verified, false);
  } finally { store.cleanup(); }
});

test("document verifier checks edit against recovery copy and refuses stale or wrong edits", async () => {
  const store = fixture();
  try {
    const backup = join(store.dir, ".draft.sara-backup-12345.txt");
    writeFileSync(backup, "Start ", "utf8");
    writeFileSync(store.path, "Start here", "utf8");
    const verifier = new DocumentVerifier(async () => ({ ok: false }));
    const result = { data: { result: { ...evidence(store.path, "Start here").data.result, backup_path: backup } } };
    assert.equal((await verifier.verify("saraDocumentEdit", { path: store.path, action: "append_text", text: "here" }, result)).verified, true);
    assert.equal((await verifier.verify("saraDocumentEdit", { path: store.path, action: "append_text", text: "wrong" }, result)).verified, false);
    assert.equal((await verifier.verify("saraDocumentEdit", { path: store.path, action: "replace_text", find: "Start ", text: "New " }, result)).verified, false);
  } finally { store.cleanup(); }
});

test("Office verification reopens document and checks Excel cell versus untrusted success", async () => {
  const store = fixture();
  try {
    const path = join(store.dir, "sheet.xlsx");
    const bytes = Buffer.from("PK\u0003\u0004fake-offline-package", "binary");
    writeFileSync(path, bytes);
    const result = { data: { result: { path, verified: true, sha256: createHash("sha256").update(bytes).digest("hex") } } };
    const agent = async (tool: string, args: Record<string, unknown>) => {
      assert.equal(tool, "saraDocumentInspect");
      assert.equal(args.path, path);
      return { ok: true, result: { verified: true, path, observation: { cells: { B2: 900 } } } };
    };
    const verifier = new DocumentVerifier(agent);
    assert.equal((await verifier.verify("saraDocumentEdit", { path, action: "set_cell", cell: "B2", value: "900" }, result)).verified, false);
    assert.equal((await verifier.verify("saraDocumentEdit", { path, action: "set_cell", cell: "B2", value: 900 }, result)).verified, true);
  } finally { store.cleanup(); }
});

test("opening an Office file requires a matching native process and visible named window", async () => {
  const store = fixture();
  try {
    const path = join(store.dir, "Report.docx");
    writeFileSync(path, Buffer.from("PK\u0003\u0004fake", "binary"));
    const reported = { data: { result: { path, verified: true } } };
    const verifier = new DocumentVerifier(async () => ({ ok: true, result: { windows: [
      { title: "Report - Google Chrome", process_name: "chrome.exe", visible: true },
    ] } }));
    assert.equal((await verifier.verify("saraDocumentOpen", { path }, reported)).verified, false);
    const matched = new DocumentVerifier(async () => ({ ok: true, result: { windows: [
      { title: "Report - Word", process_name: "WINWORD.EXE", visible: true },
    ] } }));
    assert.equal((await matched.verify("saraDocumentOpen", { path }, reported)).verified, true);
  } finally { store.cleanup(); }
});
