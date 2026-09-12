import test from "node:test";
import assert from "node:assert/strict";
import { AgiService, createAgiProxy, localProvider } from "../agi/index";

test("AGI is a no-op when disabled", async () => {
  const service = new AgiService([localProvider(async () => "should not run")]);
  assert.equal(await service.generate({ input: "hello", sessionId: "s1" }), null);
});

test("AGI uses a provider, cache, and insight layer", async () => {
  let calls = 0;
  const service = new AgiService([localProvider(async (request) => { calls++; return `reply:${request.input}`; })], { enabled: true, cacheTtlMs: 60_000 });
  const request = { input: "Can Alice help?", sessionId: "s1" };
  const first = await service.generate(request);
  const second = await service.generate(request);
  assert.equal(first?.text, "reply:Can Alice help?");
  assert.equal(second?.cached, true);
  assert.equal(calls, 1);
  const insight = await service.analyze(request.input, request.sessionId);
  assert.equal(insight.intent, "question");
  assert.deepEqual(insight.entities, ["Can Alice"]);
});

test("Proxy preserves original function behavior", async () => {
  const service = new AgiService([], { enabled: true });
  const target = { add: (left: number, right: number) => left + right };
  const proxy = createAgiProxy(service, target, "s1");
  assert.equal(await proxy.add(2, 3), 5);
});
