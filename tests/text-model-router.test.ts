import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  CompatibleTextAdapter, GeminiTextAdapter, ModelError, TextModelRouter, textModelConfigFromEnv,
} from "../src/core/models/textModelRouter";

async function localProvider(handler: (request: any) => { status?: number; body: unknown }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const result = handler({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(result.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function config(overrides: Record<string, string> = {}) {
  return textModelConfigFromEnv({
    SARA_TEXT_PROVIDER: "openai-compatible",
    SARA_TEXT_MODEL: "local-test-model",
    SARA_TEXT_OUTPUT_BUDGET: "256",
    SARA_TEXT_MAX_OUTPUT_TOKENS: "64",
    ...overrides,
  });
}

test("compatible adapter sends bounded JSON to a configured loopback provider and exposes no key in status", async () => {
  const secret = "test-api-key-not-for-client";
  let calls = 0;
  const local = await localProvider(({ url, headers, body }) => {
    calls++;
    assert.equal(url, "/v1/chat/completions");
    assert.equal(headers.authorization, `Bearer ${secret}`);
    assert.equal(body.model, "special-planner");
    assert.equal(body.max_tokens, 64);
    assert.equal(body.response_format.type, "json_object");
    return { body: { choices: [{ message: { content: '{"steps":[]}' } }], usage: { completion_tokens: 8, prompt_tokens: 17 } } };
  });
  try {
    const router = new TextModelRouter(config({ SARA_PLANNING_MODEL: "special-planner" }), [new CompatibleTextAdapter(local.url, secret)]);
    assert.equal(router.status("planning").configured, true);
    assert.equal(JSON.stringify(router.status()).includes(secret), false);
    const reply = await router.generate({ role: "planning", prompt: "plan", responseFormat: "json", maxOutputTokens: 64 });
    assert.equal(reply.text, '{"steps":[]}');
    assert.equal(reply.provider, "openai-compatible");
    assert.equal(reply.model, "special-planner");
    assert.equal(reply.usage?.outputTokens, 8);
    assert.equal(router.status().outputTokensUsed, 8);
    assert.equal(calls, 1);
  } finally { await local.close(); }
});

test("missing model config and incompatible endpoint fail closed", async () => {
  const router = new TextModelRouter(config({ SARA_TEXT_MODEL: "" }), [new CompatibleTextAdapter("")]);
  await assert.rejects(() => router.generate({ role: "chat", prompt: "hello" }), (error: any) => error.code === "NOT_CONFIGURED");
  assert.throws(() => new CompatibleTextAdapter("http://example.com/v1", "do-not-send"), /HTTPS or local loopback/);
  assert.throws(() => new CompatibleTextAdapter("https://user:secret@example.com/v1"), /HTTPS or local loopback/);
});

test("retry only retryable statuses and never show provider error bodies or secrets", async () => {
  let calls = 0;
  const secret = "private-key-should-not-appear";
  const local = await localProvider(() => {
    calls++;
    return calls === 1 ? { status: 429, body: { error: secret } }
      : { body: { choices: [{ message: { content: "answer" } }] } };
  });
  try {
    const router = new TextModelRouter(config(), [new CompatibleTextAdapter(local.url, secret)]);
    assert.equal((await router.generate({ role: "chat", prompt: "hello" })).text, "answer");
    assert.equal(calls, 2);
  } finally { await local.close(); }

  const rejected = await localProvider(() => { calls++; return { status: 401, body: { error: secret } }; });
  try {
    const router = new TextModelRouter(config(), [new CompatibleTextAdapter(rejected.url, secret)]);
    const previous = calls;
    await assert.rejects(() => router.generate({ role: "chat", prompt: "hello" }), (error: ModelError) => {
      assert.equal(error.code, "REJECTED");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(calls, previous + 1);
  } finally { await rejected.close(); }
});

test("malformed structured output and exhausted usage budget stop execution", async () => {
  const local = await localProvider(() => ({ body: { choices: [{ message: { content: "not JSON" } }] } }));
  try {
    const router = new TextModelRouter(config({ SARA_TEXT_OUTPUT_BUDGET: "64" }), [new CompatibleTextAdapter(local.url)]);
    await assert.rejects(() => router.generate({ role: "planning", prompt: "plan", responseFormat: "json", maxOutputTokens: 64 }),
      (error: ModelError) => error.code === "INVALID_RESPONSE");
    const reply = await router.generate({ role: "chat", prompt: "hello", maxOutputTokens: 64 });
    assert.equal(reply.text, "not JSON");
    await assert.rejects(() => router.generate({ role: "chat", prompt: "again", maxOutputTokens: 64 }),
      (error: ModelError) => error.code === "BUDGET_EXCEEDED");
  } finally { await local.close(); }
});

test("Gemini SDK adapter accepts a configurable model without a live API call", async () => {
  let called = "";
  const gemini = new GeminiTextAdapter(() => "fake", () => ({ models: {
    generateContent: async ({ model, config }: any) => {
      called = model;
      assert.equal(config.responseMimeType, "application/json");
      return { text: '{"ok":true}', usageMetadata: { candidatesTokenCount: 9 } };
    },
  } } as any));
  const selected = textModelConfigFromEnv({ SARA_TEXT_MODEL: "chosen-model", SARA_PLANNING_MODEL: "planning-model" });
  const router = new TextModelRouter(selected, [gemini]);
  assert.equal((await router.generate({ role: "planning", prompt: "plan", responseFormat: "json" })).text, '{"ok":true}');
  assert.equal(called, "planning-model");
});
