import test from "node:test";
import assert from "node:assert/strict";
import { getLiveReconnectDelay, LIVE_RECONNECT_MAX_ATTEMPTS } from "../../src/lib/audio";

test("live voice reconnection uses bounded exponential backoff with jitter", () => {
  assert.equal(LIVE_RECONNECT_MAX_ATTEMPTS, 5);
  assert.equal(getLiveReconnectDelay(1, () => 0), 1_000);
  assert.equal(getLiveReconnectDelay(2, () => 0.5), 2_125);
  assert.equal(getLiveReconnectDelay(100, () => 0.999), 16_249);
  assert.equal(getLiveReconnectDelay(0, () => 0), 1_000);
});
