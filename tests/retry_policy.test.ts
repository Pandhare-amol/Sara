import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRetryPolicy } from "../src/core/tools/retryPolicy";

test("retry policy allows idempotent tool retries", () => {
  assert.deepEqual(evaluateRetryPolicy("openWebsite"), { allowed: true });
});

test("retry policy blocks dangerous retries without confirmation", () => {
  const decision = evaluateRetryPolicy("whatsapp_send");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason?.includes("Explicit confirmation"), true);
});

test("retry policy permits explicitly confirmed dangerous retries", () => {
  assert.deepEqual(evaluateRetryPolicy("deleteFile", true), { allowed: true });
});
