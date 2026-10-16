import test from "node:test";
import assert from "node:assert/strict";
import { resolveAvatarPresentation } from "./avatarState";

test("avatar presentation follows the existing live and character states", () => {
  assert.deepEqual(resolveAvatarPresentation("disconnected", "idle", "idle"), {
    state: "idle",
    expression: "neutral",
    gesture: "rest",
  });
  assert.deepEqual(resolveAvatarPresentation("connecting", "thinking", "curious"), {
    state: "thinking",
    expression: "thinking",
    gesture: "think",
  });
  assert.deepEqual(resolveAvatarPresentation("listening", "idle", "happy"), {
    state: "listening",
    expression: "listening",
    gesture: "listen",
  });
  assert.deepEqual(resolveAvatarPresentation("speaking", "talking", "happy"), {
    state: "speaking",
    expression: "happy",
    gesture: "explain",
  });
});

test("explicit expression and gesture choices override automatic presentation", () => {
  assert.deepEqual(resolveAvatarPresentation("listening", "idle", "idle", "curious", "wave"), {
    state: "listening",
    expression: "curious",
    gesture: "wave",
  });
});

test("automatic emotion mapping covers the supported SARA emotion labels", () => {
  const cases = [
    ["idle", "neutral"],
    ["happy", "happy"],
    ["excited", "happy"],
    ["curious", "curious"],
    ["thinking", "thinking"],
    ["proud", "smile"],
    ["sad", "concerned"],
    ["confused", "confused"],
    ["surprised", "surprised"],
    ["embarrassed", "smile"],
    ["playful", "laugh"],
  ] as const;
  for (const [emotion, expected] of cases) {
    assert.equal(resolveAvatarPresentation("disconnected", "idle", emotion).expression, expected);
  }
});
