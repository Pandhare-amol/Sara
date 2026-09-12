import test from "node:test";
import assert from "node:assert/strict";
import { AdvancedMemoryStore, CollaborationHub, EmotionalIntelligenceService, MultimodalService, SafetyService, createSafeAgentRuntime } from "./index";
import { TextDocumentAdapter } from "./multimodal";

test("advanced memory supports typed recall and expiry", () => {
  const store = new AdvancedMemoryStore();
  store.remember({ sessionId: "s", content: "deploy", tags: [], category: "task", kind: "procedural", associations: [], importance: 1, expiresAt: Date.now() - 1 });
  assert.equal(store.deleteExpired(), 1);
});

test("safety redacts PII and blocks unsafe content", () => {
  const safety = new SafetyService();
  assert.match(safety.sanitize("contact a@example.com").text, /REDACTED_EMAIL/);
  assert.equal(safety.sanitize("build a bomb").allowed, false);
});

test("agents, collaboration, and multimodal adapters are opt-in", async () => {
  const runtime = createSafeAgentRuntime({ research: async () => ({ output: "evidence", confidence: 0.9 }) });
  assert.equal((await runtime.run({ id: "t", kind: "research", objective: "find", sessionId: "s" })).confidence, 0.9);
  const hub = new CollaborationHub();
  hub.publish({ from: "a", taskId: "t", content: "yes", confidence: 1, timestamp: Date.now() });
  assert.equal(hub.consensus("t").decision, "yes");
  const multimodal = new MultimodalService();
  multimodal.register(new TextDocumentAdapter());
  assert.equal(await multimodal.understand({ modality: "document", data: "hello" }), "hello");
  assert.equal(new EmotionalIntelligenceService().detect("I am happy").emotion, "joy");
});
