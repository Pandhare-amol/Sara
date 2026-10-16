import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { synthesizeToneSequence } from "../src/core/studio/toneSequence";

test("user-specified notes produce a validated nonempty PCM WAV, never an invented music provider output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-tone-"));
  try {
    const store = new ArtifactStore(root);
    const wav = synthesizeToneSequence("C4:1 D4:1 E4:2 R:1 F#4:1", 120);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.ok(wav.length > 90_000);
    assert.ok(wav.subarray(44).some((value) => value !== 0), "music fixture contains actual sound samples");
    const item = store.save({ kind: "tone", format: "wav", bytes: wav, prompt: "C4:1 D4:1 E4:2 R:1 F#4:1",
      provider: "local-synthesizer", model: "sine-harmonic-sequence-v1", estimatedCostUsd: 0 });
    assert.ok((item.durationSeconds || 0) > 2);
    assert.equal(store.read(item.id)?.bytes.equals(wav), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("tone parser rejects unbounded, executable, malformed and overlong requests", () => {
  assert.throws(() => synthesizeToneSequence("rm -rf /", 120), /notes/);
  assert.throws(() => synthesizeToneSequence("C4", 999), /BPM/);
  assert.throws(() => synthesizeToneSequence("C4 ".repeat(33), 120), /1–32/);
  assert.throws(() => synthesizeToneSequence("C4:4 ".repeat(30), 40), /30-second/);
  assert.throws(() => synthesizeToneSequence("A1", 120), /notes/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => synthesizeToneSequence("C4", 120, controller.signal), /cancelled/);
});
