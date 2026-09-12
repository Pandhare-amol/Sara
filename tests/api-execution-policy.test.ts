import test from "node:test";
import assert from "node:assert/strict";
import { executeApiWithPolicy } from "../src/core/api/ApiToolAdapter.ts";

test("API execution policy retries explicitly retryable failures", async () => {
  let attempts = 0;
  const result = await executeApiWithPolicy(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network unavailable");
    return "ok";
  }, { maxAttempts: 2, timeoutMs: 100 });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("API execution policy does not retry non-retryable failures", async () => {
  let attempts = 0;
  await assert.rejects(() => executeApiWithPolicy(async () => {
    attempts += 1;
    throw new Error("authentication failed");
  }, { maxAttempts: 3, timeoutMs: 100 }));

  assert.equal(attempts, 1);
});

test("API execution policy enforces a timeout", async () => {
  await assert.rejects(
    () => executeApiWithPolicy(() => new Promise(() => undefined), { timeoutMs: 5 }),
    /timed out/i,
  );
});