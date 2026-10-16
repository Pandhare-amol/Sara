import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicTextAdapter, OpenAITextAdapter, TextModelRouter, textModelConfigFromEnv, ModelError,
} from "../src/core/models/textModelRouter";

const config = (provider: "anthropic" | "openai", extra: Record<string, string> = {}) => textModelConfigFromEnv({
  SARA_TEXT_PROVIDER: provider, SARA_TEXT_MODEL: "chosen-model", SARA_TEXT_MAX_OUTPUT_TOKENS: "64",
  ...extra,
});

test("official OpenAI adapter makes an actual HTTP POST through the configured transport, without leaking its key in status", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer private-example-key");
    assert.equal(JSON.parse(String(init?.body)).model, "chosen-model");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Answer" } }],
      usage: { prompt_tokens: 9, completion_tokens: 2 } }), { status: 200 });
  };
  const router = new TextModelRouter(config("openai", {
    SARA_OPENAI_INPUT_USD_PER_MILLION: "1", SARA_OPENAI_OUTPUT_USD_PER_MILLION: "2",
    SARA_TEXT_MAX_ESTIMATED_USD: "0.001",
  }), [new OpenAITextAdapter("private-example-key", fetcher)]);
  assert.equal(router.status().connection, "untested");
  assert.equal(router.providerStatuses().find((s) => s.provider === "openai")?.configured, true);
  const result = await router.generate({ role: "chat", prompt: "Please answer" });
  assert.equal(result.text, "Answer"); assert.equal(result.provider, "openai");
  assert.ok((result.estimatedCostUsd || 0) > 0);
  assert.equal(router.status().connection, "succeeded");
  assert.equal(JSON.stringify(router.providerStatuses()).includes("private-example-key"), false);
  assert.equal(calls, 1, "status is NOT a connection test or live request");
});

test("Anthropic Messages REST and authentic SSE deltas, usage, and end markers", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], "secret-anthropic");
    assert.equal((init?.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "chosen-model");
    if (!body.stream) return new Response(JSON.stringify({ content: [{ type: "text", text: "Acknowledged" }],
      stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } }), { status: 200 });
    const frames = [
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Go"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"od"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const item of frames) controller.enqueue(new TextEncoder().encode(item));
      controller.close();
    } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const router = new TextModelRouter(config("anthropic"), [new AnthropicTextAdapter("secret-anthropic", fetcher)]);
  assert.equal((await router.generate({ role: "research", prompt: "Source summary" })).usage?.inputTokens, 7);
  const deltas: string[] = [];
  const response = await router.stream({ role: "verification", prompt: "Review" }, (text) => deltas.push(text));
  assert.deepEqual(deltas, ["Go", "od"]); assert.equal(response.text, "Good");
  assert.equal(response.streamed, true); assert.equal(response.usage?.outputTokens, 2);
  assert.equal(calls, 2);
});

test("provider 429 honors a bounded retry-after and never reveals the provider response body", async () => {
  let calls = 0;
  const router = new TextModelRouter(config("anthropic", { SARA_TEXT_MAX_ATTEMPTS: "3" }), [
    new AnthropicTextAdapter("secret", async () => {
      calls++;
      return new Response("secret body", { status: 429, headers: { "retry-after": "60" } });
    }),
  ]);
  await assert.rejects(router.generate({ role: "chat", prompt: "test" }), (err: ModelError) => {
    assert.equal(err.code, "RATE_LIMIT"); assert.doesNotMatch(err.message, /secret/); return true;
  });
  assert.equal(calls, 1, "do not sleep a minute or blindly retry a provider's rate-limit response");
  assert.equal(router.status().connection, "failed");
});

test("unpriced providers are denied when a monetary budget is configured", async () => {
  let calls = 0;
  const router = new TextModelRouter(config("openai", { SARA_TEXT_MAX_ESTIMATED_USD: "0" }), [
    new OpenAITextAdapter("private", async () => { calls++; throw new Error("should not contact"); }),
  ]);
  await assert.rejects(router.generate({ role: "chat", prompt: "hello" }), (err: ModelError) => err.code === "BUDGET_EXCEEDED");
  assert.equal(calls, 0);
  assert.throws(() => textModelConfigFromEnv({ SARA_TEXT_PROVIDER: "magical-free-api" }), /Unsupported/);
});

test("truncated Anthropic response is never treated as a verified complete proposal", async () => {
  const adapter = new AnthropicTextAdapter("secret", async () => new Response(JSON.stringify({ content: [{ type: "text", text: "partial" }],
    stop_reason: "max_tokens" }), { status: 200 }));
  const router = new TextModelRouter(config("anthropic"), [adapter]);
  await assert.rejects(router.generate({ role: "chat", prompt: "test" }), (err: ModelError) => err.code === "INVALID_RESPONSE");
});
