import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { createOfficeExport, inspectOfficeExport } from "../src/core/studio/officeExports";

for (const [format, source, expectedPart, text] of [
  ["docx", "# Title\nBonjour, नमस्कार.", "word/document.xml", "नमस्कार"],
  ["xlsx", "name,note\nAlice,\"hello, world\"\nBob,test", "xl/worksheets/sheet1.xml", "hello, world"],
  ["pptx", "# Scene One\nIntro\n## Scene Two\nOutro", "ppt/slides/slide1.xml", "Scene One"],
] as const) {
  test(`${format} export creates a new ZIP/OOXML artifact, CRC checks pass and the text is readable`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sara-${format}-test-`));
    try {
      const store = new ArtifactStore(root);
      const input = store.save({ kind: "document", format: format === "xlsx" ? "csv" : "md", bytes: Buffer.from(source),
        prompt: "Write local Office content", provider: "fixture", model: "fixture" });
      const bytes = await createOfficeExport(format, source);
      const validation = await inspectOfficeExport(bytes, format);
      assert.match(validation.detail, /CRC/);
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      assert.match((await zip.file(expectedPart)?.async("string")) || "", new RegExp(text));
      const saved = store.save({ kind: format === "pptx" ? "presentation" : format === "xlsx" ? "spreadsheet" : "document",
        format, bytes, prompt: `Export from ${input.id}`, provider: "local", model: "test", parentId: input.id, estimatedCostUsd: 0 });
      assert.equal(saved.parentId, input.id);
      assert.equal(store.read(input.id)?.bytes.toString(), source);
      assert.equal(store.read(saved.id)?.bytes.equals(bytes), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("spreadsheet CSV parsing denies formula injection and mismatched rows; Office container rejects forged bytes", async () => {
  for (const invalid of ["a,b\n=x,ok", "a,b\n\"@SUM(A1)\",ok", "a,b\nhi", "a,b\n\"never closed", "a,b\n\"value\"extra,ok"]) {
    await assert.rejects(createOfficeExport("xlsx", invalid));
  }
  await assert.rejects(inspectOfficeExport(Buffer.from("PK\x03\x04"), "pptx"), /ZIP/);
  const bytes = await createOfficeExport("xlsx", "title,caption\nA,B");
  const damaged = Buffer.from(bytes); damaged[110] ^= 0xff;
  await assert.rejects(inspectOfficeExport(damaged, "xlsx"));
});
