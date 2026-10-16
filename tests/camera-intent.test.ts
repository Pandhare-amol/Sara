import test from "node:test";
import assert from "node:assert/strict";
import { cameraActionRequested } from "../src/core/camera/cameraIntent";

test("a model call is not a user request to start a camera or capture a picture", () => {
  assert.equal(cameraActionRequested("photo", "What is on my shared screen?"), false);
  assert.equal(cameraActionRequested("start", "What is on my shared screen?"), false);
  assert.equal(cameraActionRequested("photo", "Take a selfie please"), true);
  assert.equal(cameraActionRequested("analyze", "What am I wearing?"), true);
  assert.equal(cameraActionRequested("record_start", "Start recording a video"), true);
  assert.equal(cameraActionRequested("record_start", "play a video"), false);
  assert.equal(cameraActionRequested("stop", "stop the camera"), true);
});
