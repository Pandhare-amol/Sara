import test from "node:test";
import assert from "node:assert/strict";
import { ApiGateway, PriorityJobQueue, ReadOnlyDatabaseAssistant } from "./ecosystem";
import { MetricsRegistry } from "./observability";
import { ConsentManager, validateExternalUrl } from "./security";

test("gateway routes requests and enforces limits", async () => {
  const gateway = new ApiGateway("v1", 1);
  gateway.register("POST", "/agi", async () => ({ status: 200, body: { ok: true } }));
  assert.equal((await gateway.handle({ method: "POST", path: "/api/v1/agi", userId: "u" })).status, 200);
  assert.equal((await gateway.handle({ method: "POST", path: "/api/v1/agi", userId: "u" })).status, 429);
});

test("queue prioritizes work and database blocks unsafe SQL", async () => {
  const queue = new PriorityJobQueue<string>();
  const low = queue.enqueue("low", 1); const high = queue.enqueue("high", 2);
  await queue.process(async () => undefined);
  assert.equal(queue.status(high.id)?.status, "completed");
  assert.equal(queue.status(low.id)?.status, "queued");
  const database = new ReadOnlyDatabaseAssistant({ schema: async () => "users", query: async () => [] });
  await assert.rejects(() => database.executeSafe("DELETE FROM users"));
});

test("security and metrics provide integration primitives", () => {
  const consent = new ConsentManager(); consent.grant("u", "search"); assert.equal(consent.has("u", "search"), true);
  assert.throws(() => validateExternalUrl("http://127.0.0.1/admin"));
  const metrics = new MetricsRegistry(); metrics.observe("latency", 10); metrics.observe("latency", 20); assert.equal(metrics.percentile("latency", 50), 10);
});
