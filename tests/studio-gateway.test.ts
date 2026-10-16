import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { StudioBudget } from "../src/core/studio/studioBudget";
import { GenerationGateway } from "../src/core/studio/generationGateway";
import { StudioJobs } from "../src/core/studio/studioJobs";
import type { TextModelRouter } from "../src/core/models/textModelRouter";

const textModel = { status: () => ({ configured: true }), generate: async () =>
  ({ text: "# Provider-produced document\nA plain verified file, not verified factual claims.", provider: "gemini" as const,
    model: "fixture", usage: { inputTokens: 10, outputTokens: 15 }, estimatedCostUsd: 0.001 }) } as unknown as Pick<TextModelRouter, "status" | "generate">;
function makeWav() {
  const data = Buffer.alloc(16000);
  const out = Buffer.alloc(44 + data.length); out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36);
  out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
}

async function finished(jobs: StudioJobs, id: string) {
  for (let index = 0; index < 30; index++) {
    const current = jobs.get(id);
    if (current && ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture job did not finish.");
}

test("capability routing, real bytes, reservations and revision history use fixture providers only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-studio-gateway-"));
  try {
    const store = new ArtifactStore(root), budget = new StudioBudget(path.join(root, "budget.json"), 0.06);
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(55);
    const imageBytes = PNG.sync.write(png);
    const imagePayload = JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] });
    const env = { OPENAI_API_KEY: "fixture-only", SARA_IMAGE_PROVIDER: "openai", SARA_IMAGE_MODEL: "fixture-image",
      SARA_IMAGE_EDIT_PROVIDER: "openai", SARA_IMAGE_EDIT_MODEL: "fixture-edit",
      SARA_IMAGE_EDIT_ESTIMATED_COST_USD: "0.015", SARA_AUDIO_PROVIDER: "openai", SARA_AUDIO_MODEL: "fixture-voice",
      SARA_IMAGE_ESTIMATED_COST_USD: "0.04", SARA_AUDIO_ESTIMATED_COST_USD_PER_1K_CHARS: "0.015" };
    const calls: string[] = [];
    const fetcher = (async (url: string, options?: RequestInit) => {
      calls.push(url); assert.equal(options?.redirect, "error");
      if (url.endsWith("/edits")) {
        assert.ok(options?.body instanceof FormData);
        assert.equal(options.body.get("model"), "fixture-edit");
        assert.equal(options.body.get("image") instanceof Blob, true);
        assert.equal((options.body.get("image") as Blob).size, imageBytes.length);
      }
      return url.endsWith("speech") ? new Response(makeWav(), { status: 200, headers: { "Content-Type": "audio/wav" } })
        : new Response(imagePayload, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const gateway = new GenerationGateway(textModel, store, () => undefined, env, fetcher, undefined, budget);
    assert.equal(gateway.capabilities().find((c) => c.modality === "video")?.configured, false);
    assert.equal(gateway.capabilities().find((c) => c.modality === "image")?.connection, "untested");
    const jobs = new StudioJobs(gateway);
    const queued = jobs.submit({ modality: "image", prompt: "A bright orange fruit", format: "png", aspectRatio: "1:1" });
    const done = await finished(jobs, queued.id);
    assert.equal(done.status, "COMPLETED"); assert.equal(store.read(done.artifactId!)?.bytes.equals(imageBytes), true);
    assert.equal(gateway.capabilities().find((c) => c.modality === "image")?.connection, "succeeded");
    await assert.rejects(gateway.generate({ modality: "image", prompt: "A second fruit", format: "png", aspectRatio: "1:1" }), /budget/);
    const audio = await gateway.generate({ modality: "narration", prompt: "Hello world", format: "wav", voice: "nova" });
    assert.equal(audio.format, "wav"); assert.equal(calls.length, 2);
    const edited = await gateway.generate({ modality: "image-edit", prompt: "Change the hue but keep the composition",
      format: "png", parentId: done.artifactId });
    assert.equal(edited.parentId, done.artifactId);
    assert.equal(store.read(done.artifactId!)?.bytes.equals(imageBytes), true, "reference is never overwritten");
    assert.equal(calls.at(-1), "https://api.openai.com/v1/images/edits");
    const first = await gateway.generate({ modality: "text", format: "md", prompt: "Write a draft" });
    const revised = await gateway.generate({ modality: "text", format: "md", prompt: "Make it concise", parentId: first.id });
    assert.equal(revised.parentId, first.id); assert.ok(store.read(first.id));
    assert.ok(budget.snapshot().estimatedReservedUsd > 0.055);
    assert.ok(budget.snapshot().estimatedReservedUsd < 0.056);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("studio cancellation stops queued work without calling a provider", async () => {
  const called: string[] = [];
  const jobs = new StudioJobs({ generate: async () => { called.push("provider"); throw new Error("unexpected"); } } as unknown as GenerationGateway);
  const queued = jobs.submit({ modality: "text", format: "md", prompt: "Make a report" });
  assert.equal(jobs.cancel(queued.id)?.status, "CANCEL_REQUESTED");
  assert.equal((await finished(jobs, queued.id)).status, "CANCELLED");
  assert.deepEqual(called, []);
});
