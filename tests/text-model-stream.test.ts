import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CompatibleTextAdapter, GeminiTextAdapter, ModelError, TextModelRouter, textModelConfigFromEnv, type TextModelAdapter } from "../src/core/models/textModelRouter";

async function provider(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  }) };
}
const config = () => textModelConfigFromEnv({ SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "mock",
  SARA_TEXT_MAX_ATTEMPTS: "2", SARA_TEXT_MAX_OUTPUT_TOKENS: "64", SARA_TEXT_OUTPUT_BUDGET: "256" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("OpenAI-compatible SSE provides real deltas across fragmented UTF-8 frames before completion", async () => {
  let resume!: () => void;
  const hold = new Promise<void>((resolve) => { resume = resolve; });
  const local = await provider(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(input.stream, true);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const first = Buffer.from('data: {"choices":[{"delta":{"content":"Hello 🌍"}}]}\n\n');
    res.write(first.subarray(0, first.length - 4));
    res.write(first.subarray(first.length - 4));
    await hold;
    res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const router = new TextModelRouter(config(), [new CompatibleTextAdapter(local.url, "secret")]);
    const deltas: string[] = [];
    const answer = router.stream({ role: "chat", prompt: "hi" }, (delta) => deltas.push(delta));
    for (let i = 0; i < 200 && !deltas.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(deltas, ["Hello 🌍"], "text must arrive before the provider finishes");
    resume();
    const result = await answer;
    assert.equal(result.text, "Hello 🌍 there");
    assert.equal(result.streamed, true);
    assert.equal(result.usage?.outputTokens, 3);
    assert.equal(router.status().outputTokensUsed, 3);
  } finally { resume(); await local.close(); }
});

test("partial SSE or missing DONE is an error, never replayed, persisted or presented as completion", async () => {
  let calls = 0;
  const local = await provider((_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  try {
    const router = new TextModelRouter(config(), [new CompatibleTextAdapter(local.url)]);
    const deltas: string[] = [];
    await assert.rejects(router.stream({ role: "chat", prompt: "hi" }, (part) => deltas.push(part)),
      (error: unknown) => error instanceof ModelError && error.code === "NETWORK");
    assert.deepEqual(deltas, ["partial"]);
    assert.equal(calls, 1, "a partial reply must never be retried into a second reply");
    assert.equal(router.status().outputTokensUsed, 64, "conservatively account for streamed usage");
  } finally { await local.close(); }
});

test("adapter without genuine streaming emits one final text with streamed=false", async () => {
  const adapter: TextModelAdapter = { name: "openai-compatible", available: () => true,
    generate: async () => ({ text: "complete answer" }) };
  const router = new TextModelRouter(config(), [adapter]);
  const deltas: string[] = [];
  const result = await router.stream({ role: "chat", prompt: "hi" }, (delta) => deltas.push(delta));
  assert.equal(result.streamed, false);
  assert.deepEqual(deltas, ["complete answer"]);
});

test("Gemini SDK async iterator is used directly, without a synthetic voice or external API", async () => {
  const adapter = new GeminiTextAdapter(() => "test-key", () => ({ models: {
    generateContentStream: async () => (async function* () {
      yield { text: "one" };
      await tick();
      yield { text: " two", usageMetadata: { candidatesTokenCount: 2 } };
    })(),
  } } as any));
  const router = new TextModelRouter(textModelConfigFromEnv({ SARA_TEXT_PROVIDER: "gemini", SARA_TEXT_MODEL: "mock" }), [adapter]);
  const deltas: string[] = [];
  const result = await router.stream({ role: "chat", prompt: "hi" }, (delta) => deltas.push(delta));
  assert.deepEqual(deltas, ["one", " two"]);
  assert.equal(result.text, "one two");
  assert.equal(result.streamed, true);
});
