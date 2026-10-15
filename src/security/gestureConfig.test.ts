import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeGestureConfig } from "./gestureConfig";

test("gesture config accepts bounded confidence, frame count, and calibration settings", () => {
  assert.deepEqual(sanitizeGestureConfig({
    min_confidence: 0.9,
    frames_required: 3,
    calibration: {
      camera_center: [0.5, 0.5],
      screen_top_left: [0, 0],
      screen_top_right: [1920, 0],
    },
  }), {
    min_confidence: 0.9,
    frames_required: 3,
    calibration: {
      camera_center: [0.5, 0.5],
      screen_top_left: [0, 0],
      screen_top_right: [1920, 0],
    },
  });
});

test("gesture config rejects unknown fields and out-of-range values", () => {
  assert.throws(() => sanitizeGestureConfig({ arbitraryTool: "deleteFile" }), /Unsupported gesture config field/i);
  assert.throws(() => sanitizeGestureConfig({ min_confidence: 1.1 }), /between 0 and 1/i);
  assert.throws(() => sanitizeGestureConfig({ frames_required: 0 }), /between 1 and 60/i);
  assert.throws(() => sanitizeGestureConfig({ calibration: { camera_center: [2, 0.5] } }), /coordinate range/i);
  assert.throws(() => sanitizeGestureConfig({ calibration: { screen_top_left: [0] } }), /exactly two/i);
  assert.throws(() => sanitizeGestureConfig({ calibration: { unexpected_point: [1, 1] } }), /Unsupported calibration point/i);
});
