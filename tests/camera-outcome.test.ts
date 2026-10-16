import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCameraResult } from "../src/core/camera/verifyCameraResult";

test("camera commands must not imply a saved photo without a real recent image file", () => {
  const root = mkdtempSync(join(tmpdir(), "sara-camera-outcome-"));
  try {
    const startedAt = Date.now();
    const filename = `${startedAt}-a1b2c3d4e5f6.jpg`;
    const path = join(root, "photos", filename);
    const response = { ok: true, filename, path };
    assert.equal(verifyCameraResult("photo", response, startedAt, root).ok, false);
    mkdirSync(join(root, "photos"));
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200)]));
    assert.equal(verifyCameraResult("photo", response, startedAt, root).verified, true);
    assert.equal(verifyCameraResult("photo", { ...response, path: "/tmp/other.jpg" }, startedAt, root).verified, false);
    assert.equal(verifyCameraResult("photo", { ok: true, filename: "../../etc/passwd", path }, startedAt, root).verified, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("analysis and camera preview remain distinct from verified saved media", () => {
  assert.equal(verifyCameraResult("start", { ok: true, status: "active", streamActive: true }, 0, "/tmp").verified, false);
  assert.equal(verifyCameraResult("analyze", { ok: true, text: "Blue jacket." }, 0, "/tmp").text, "Blue jacket.");
  assert.equal(verifyCameraResult("analyze", { ok: true, text: "" }, 0, "/tmp").ok, false);
  assert.equal(verifyCameraResult("record_stop", { ok: false, error: "Saving failed" }, 0, "/tmp").verified, false);
});
