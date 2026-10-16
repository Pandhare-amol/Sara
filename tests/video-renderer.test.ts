import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { VideoRenderer } from "../src/core/studio/videoRenderer";

function image(value: number): Buffer {
  const png = new PNG({ width: 80, height: 50 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = value; png.data[index + 1] = 25; png.data[index + 2] = 220 - value; png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("video encoder stays unavailable without an explicit reviewed local binary; forged paths and frame IDs fail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-video-disabled-"));
  try {
    const store = new ArtifactStore(root);
    const off = new VideoRenderer(store, {});
    assert.equal(off.status().configured, false);
    await assert.rejects(off.render({ imageIds: ["forged"], secondsPerImage: 1 }), /not configured/);
    const withBinary = new VideoRenderer(store, { SARA_FFMPEG_PATH: "/does/not/exist/ffmpeg" });
    assert.equal(withBinary.status().configured, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real local FFmpeg fixture makes and decodes a bounded MP4 from separate saved PNGs", {
  skip: !process.env.SARA_TEST_FFMPEG_PATH ? "No opt-in FFmpeg fixture binary is configured" : false,
  timeout: 45_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-video-real-local-"));
  try {
    const store = new ArtifactStore(root);
    const slides = [30, 190].map((color) => store.save({ kind: "image", format: "png", bytes: image(color),
      prompt: `Color slide ${color}`, provider: "local-test-image", model: "fixture" }));
    const renderer = new VideoRenderer(store, { SARA_FFMPEG_PATH: process.env.SARA_TEST_FFMPEG_PATH });
    assert.equal(renderer.status().configured, true);
    await assert.rejects(renderer.render({ imageIds: [slides[0].id, slides[0].id], secondsPerImage: 2 }), /distinct/);
    await assert.rejects(renderer.render({ imageIds: ["../private"], secondsPerImage: 2 }), /Choose/);
    const output = await renderer.render({ imageIds: slides.map((slide) => slide.id), secondsPerImage: 1 });
    const saved = store.save({ kind: "video", format: "mp4", bytes: output, prompt: "Make a two-slide local MP4",
      provider: "local-ffmpeg", model: "cut-only-h264-720p", estimatedCostUsd: 0 });
    assert.ok((saved.durationSeconds || 0) >= 1.5 && (saved.durationSeconds || 0) <= 2.5);
    assert.ok(store.read(saved.id)?.bytes.equals(output));
    assert.match(output.subarray(4, 12).toString("ascii"), /ftyp/);
    assert.throws(() => store.save({ kind: "video", format: "mp4", bytes: Buffer.from("fake movie"),
      prompt: "Make a video", provider: "fixture", model: "fixture" }), /MP4/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
