import test from "node:test";
import assert from "node:assert/strict";
import { ChatStreamError, readChatStream } from "../src/lib/chatStream";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const metrics = { ackMs: 1, firstTextMs: 3, completionMs: 4, modelMs: 2,
  streamed: true, fallback: false, cpuUserMs: 1, cpuSystemMs: 0, rssMb: 90 };
function response(chunks: string[]): Response {
  const bytes = chunks.map((part) => new TextEncoder().encode(part));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const item of bytes) controller.enqueue(item);
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}

test("client reads fragmented text and only accepts a matching final done event", async () => {
  const payload = frame("ack", { ackMs: 1 }) + frame("text", { text: "Hello " }) + frame("text", { text: "🌍" }) +
    frame("done", { ok: true, text: "Hello 🌍", userId: "default-user", conversationId: "one", metrics });
  const raw = new TextEncoder().encode(payload);
  const emojiAt = raw.indexOf(0xf0);
  const text = new TextDecoder().decode(raw.slice(0, emojiAt + 2));
  // Split the UTF-8 sequence at the byte boundary, not a JavaScript character.
  const body = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(raw.slice(0, emojiAt + 2));
    controller.enqueue(raw.slice(emojiAt + 2));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  assert.ok(text.includes("\ufffd"), "fixture must split a multibyte code point");
  const deltas: string[] = [];
  const done = await readChatStream(body, (part) => deltas.push(part));
  assert.equal(done.text, "Hello 🌍");
  assert.deepEqual(deltas, ["Hello ", "🌍"]);
});

test("client refuses partial streams, forged completion and explicit error events", async () => {
  const prefix = frame("ack", {}) + frame("text", { text: "Draft" });
  for (const tail of ["", frame("done", { ok: true, text: "Different", userId: "owner", conversationId: "one", metrics }),
    frame("error", { error: "Not saved", code: "INTERRUPTED", partial: true })]) {
    const fragments: string[] = [];
    await assert.rejects(readChatStream(response([prefix, tail]), (part) => fragments.push(part)),
      (error: unknown) => error instanceof ChatStreamError && error.partial);
    assert.deepEqual(fragments, ["Draft"]);
  }
});
