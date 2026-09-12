import test from "node:test";
import assert from "node:assert/strict";
import { AgiService, localProvider, resolveAgiConfig, RolloutManager, CircuitBreaker, retry } from "./index";

test("retry uses bounded attempts and fallback provider survives primary failure", async () => {
  let attempts = 0;
  const service = new AgiService([
    localProvider(async () => { attempts++; throw new Error("primary unavailable"); }),
    { name: "custom", generate: async () => "fallback" },
  ], { enabled: true, provider: "local", retryCount: 1, retryBaseDelayMs: 0, storage: "memory" });
  const result = await service.generate({ input: "hello", sessionId: "production" });
  assert.equal(result?.text, "fallback");
  assert.equal(attempts, 2);
});

test("circuit breaker opens after threshold and retry preserves final error", async () => {
  const breaker = new CircuitBreaker(2, 60_000);
  await assert.rejects(() => breaker.execute(async () => { throw new Error("down"); }));
  await assert.rejects(() => breaker.execute(async () => { throw new Error("down"); }));
  assert.equal(breaker.getState(), "open");
  await assert.rejects(() => breaker.execute(async () => "unreachable"), /Circuit is open/);
  let calls = 0;
  await assert.rejects(() => retry(async () => { calls++; throw new Error("failed"); }, { attempts: 3, baseDelayMs: 0, sleep: async () => undefined }), /failed/);
  assert.equal(calls, 3);
});

test("rollout is deterministic and supports tenant overrides and rollback", () => {
  const rollout = new RolloutManager();
  rollout.setFlag("assistant", { enabled: true, percentage: 100, cohort: "beta", variant: "model-a" });
  assert.equal(rollout.enabled("assistant", { userId: "u", cohort: "beta" }), true);
  assert.equal(rollout.enabled("assistant", { userId: "u", cohort: "internal" }), false);
  rollout.setTenantFlag("tenant-a", "assistant", false);
  assert.equal(rollout.enabled("assistant", { userId: "u", tenantId: "tenant-a", cohort: "beta" }), false);
  rollout.record(false, 10); rollout.record(true, 10); rollout.record(true, 10);
  assert.equal(rollout.shouldRollback(), true);
  rollout.rollback("assistant");
  assert.equal(rollout.enabled("assistant", { userId: "u", cohort: "beta" }), false);
});

test("production configuration rejects unsafe tuning values", () => {
  assert.throws(() => resolveAgiConfig({ contextWindow: 10 }), /contextWindow/);
  assert.throws(() => resolveAgiConfig({ requestTimeoutMs: 0 }), /requestTimeoutMs/);
});
