import test from "node:test";
import assert from "node:assert/strict";
import { ScreenVerifier } from "../src/core/tools/verification/screenVerifier.ts";

test("screen verifier returns verified capture evidence for a real artifact payload", async () => {
  const verifier = new ScreenVerifier();
  const result = await verifier.verify("takeScreenshot", {}, {
    screenshot_id: "screen-test-1",
    width: 1366,
    height: 768,
  });

  assert.equal(result.verified, true);
  assert.equal(result.method, "screen");
  assert.equal(result.observedState?.screenshotId, "screen-test-1");
  assert.deepEqual(result.observedState?.dimensions, { width: 1366, height: 768 });
});