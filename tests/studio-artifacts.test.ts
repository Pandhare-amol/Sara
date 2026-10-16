import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";
import { ArtifactStore, createPlainPdf } from "../src/core/studio/artifactStore";

function wav(): Buffer {
  const data = Buffer.alloc(16000 * 2 / 2); // half a second at 16kHz, mono, 16 bit
  const out = Buffer.alloc(44 + data.length);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36);
  out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
}

test("validated PNG, WAV, PDF and text are real private files; revisions preserve originals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-studio-artifact-"));
  try {
    const store = new ArtifactStore(root);
    const png = new PNG({ width: 2, height: 3 }); png.data.fill(100);
    const image = store.save({ kind: "image", format: "png", bytes: PNG.sync.write(png), prompt: "Create art",
      provider: "fixture-provider", model: "fixture" });
    assert.deepEqual(image.dimensions, { width: 2, height: 3 });
    const audio = store.save({ kind: "narration", format: "wav", bytes: wav(), prompt: "Speak clearly", provider: "fixture", model: "fixture" });
    assert.ok((audio.durationSeconds || 0) > 0.1);
    const pdf = await createPlainPdf("Sample", "This is a validated file.");
    const report = store.save({ kind: "document", format: "pdf", bytes: pdf, prompt: "Report", provider: "fixture", model: "fixture" });
    assert.equal((await PDFDocument.load(store.read(report.id)!.bytes)).getPageCount(), 1);
    const original = store.save({ kind: "text", format: "md", bytes: Buffer.from("# First draft"), prompt: "Draft", provider: "fixture", model: "fixture" });
    const next = store.save({ kind: "text", format: "md", bytes: Buffer.from("# New draft"), prompt: "Revise", parentId: original.id,
      provider: "fixture", model: "fixture" });
    assert.equal(next.parentId, original.id);
    assert.equal(store.read(original.id)?.bytes.toString(), "# First draft");
    assert.equal(store.verify(original.id)?.sha256, original.sha256);
    assert.equal(new ArtifactStore(root).list().length, 5);
    // Reject an on-disk replacement before allocating its contents in memory.
    fs.appendFileSync(path.join(root, "artifacts", original.fileName), Buffer.alloc(1024));
    assert.equal(store.read(original.id), undefined);
    assert.equal(store.verify(original.id), undefined);
    assert.equal(store.read(next.id)?.bytes.toString(), "# New draft");
    if (process.platform !== "win32") {
      const nextPath = path.join(root, "artifacts", next.fileName);
      fs.unlinkSync(nextPath);
      fs.symlinkSync(path.join(root, "artifacts", original.fileName), nextPath);
      assert.equal(store.verify(next.id), undefined, "a replaced file must not escape the private directory");
    }
    assert.equal(store.delete(image.id), true); assert.equal(store.read(image.id), undefined);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "history.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("corrupt media, formula injection and unsupported multilingual PDF fail without files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-studio-invalid-"));
  try {
    const store = new ArtifactStore(root);
    assert.throws(() => store.save({ kind: "image", format: "png", bytes: Buffer.from("fake"),
      prompt: "art", provider: "fixture", model: "fixture" }), /PNG/);
    assert.throws(() => store.save({ kind: "narration", format: "wav", bytes: Buffer.from("RIFF"),
      prompt: "audio", provider: "fixture", model: "fixture" }), /WAV/);
    assert.throws(() => store.save({ kind: "document", format: "csv", bytes: Buffer.from("name,note\nAlice,=1+2"),
      prompt: "table", provider: "fixture", model: "fixture" }), /formula/);
    await assert.rejects(createPlainPdf("Report", "नमस्कार"), /Latin text/);
    assert.deepEqual(store.list(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
