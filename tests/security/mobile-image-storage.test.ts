import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeMobileImage, storeMobileImage } from "../../src/security/mobileImageStorage";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("mobile image uploads accept supported image bytes and store only beneath the private data directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sara-mobile-image-"));
  try {
    const decoded = decodeMobileImage(pngBytes.toString("base64"), "image/png");
    const stored = storeMobileImage(tempRoot, decoded);
    const expectedDir = path.join(tempRoot, "images");
    const savedPath = path.join(expectedDir, stored.filename);

    assert.equal(stored.mimeType, "image/png");
    assert.deepEqual(fs.readFileSync(savedPath), pngBytes);
    assert.equal(path.dirname(savedPath), expectedDir);
    assert.match(stored.filename, /^mobile-\d+-[a-f0-9]{24}\.png$/);
    assert.equal(fs.statSync(savedPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(process.cwd(), "assets", stored.filename)), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mobile image uploads reject invalid base64, MIME mismatches and unsupported formats", () => {
  assert.throws(() => decodeMobileImage("not base64", "image/png"), /base64/);
  assert.throws(() => decodeMobileImage(pngBytes.toString("base64"), "image/jpeg"), /MIME type/);
  assert.throws(() => decodeMobileImage(pngBytes.toString("base64"), "text/plain"), /MIME type/);
  assert.throws(() => decodeMobileImage(`data:image/png;base64,${pngBytes.toString("base64")}`, "image/jpeg"), /does not match/);
});
