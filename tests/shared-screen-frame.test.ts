import test from "node:test";
import assert from "node:assert/strict";
import { validSharedJpeg, sharedScreenStatus } from "../src/core/context/sharedScreenFrames";

test("only bounded JPEG frames count as authorized Live visual input", () => {
  const smallJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]).toString("base64");
  assert.equal(validSharedJpeg(smallJpeg), true);
  assert.equal(validSharedJpeg("not a JPEG"), false);
  assert.equal(validSharedJpeg("A".repeat(1_500_001)), false);
  assert.equal(validSharedJpeg(Buffer.from("other image").toString("base64")), false);
});

test("stale frames cannot be described as the currently shared screen", () => {
  assert.equal(sharedScreenStatus(0, 10_000).fresh_frame, false);
  assert.equal(sharedScreenStatus(9_000, 10_000).fresh_frame, true);
  assert.equal(sharedScreenStatus(1_000, 10_000).fresh_frame, false);
  assert.equal(sharedScreenStatus(1_000, 10_000).frame_age_ms, 9_000);
});
