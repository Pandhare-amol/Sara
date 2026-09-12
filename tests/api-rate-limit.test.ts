import test from "node:test";
import assert from "node:assert/strict";
import { ApiRateLimitManager } from "../src/core/api/ApiRateLimitManager.ts";

test("rate limit manager allows configured capacity and returns retry timing", () => {
  const manager = new ApiRateLimitManager();
  const policy = { requestsPerMinute: 2 };
  const now = 1_000_000;

  assert.equal(manager.consume("demo", policy, now).allowed, true);
  assert.equal(manager.consume("demo", policy, now + 1).allowed, true);
  const blocked = manager.consume("demo", policy, now + 2);
  assert.equal(blocked.allowed, false);
  assert.ok((blocked.retryAfterMs ?? 0) > 0);
  assert.ok((blocked.retryAfterMs ?? 0) <= 60_000);
  assert.equal(manager.consume("demo", policy, now + 60_000).allowed, true);
});

test("rate limit manager keeps providers isolated", () => {
  const manager = new ApiRateLimitManager();
  const policy = { requestsPerDay: 1 };
  const now = 2_000_000;

  assert.equal(manager.consume("one", policy, now).allowed, true);
  assert.equal(manager.consume("one", policy, now + 1).allowed, false);
  assert.equal(manager.consume("two", policy, now + 1).allowed, true);
});