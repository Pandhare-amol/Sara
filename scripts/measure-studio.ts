import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PNG } from "pngjs";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { GenerationGateway } from "../src/core/studio/generationGateway";
import { StudioJobs } from "../src/core/studio/studioJobs";
import { createOfficeExport } from "../src/core/studio/officeExports";
import { VideoRenderer } from "../src/core/studio/videoRenderer";
import { synthesizeToneSequence } from "../src/core/studio/toneSequence";
import type { TextModelRouter } from "../src/core/models/textModelRouter";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-studio-measure-"));
const startRss = process.memoryUsage().rss;
const startCpu = process.cpuUsage();
const metrics: Record<string, unknown> = { classification: "local fixture only, no live provider or native Office",
  measuredAt: new Date().toISOString(), connectedProviders: 0 };
try {
  const store = new ArtifactStore(directory);
  const fixture = { status: () => ({ configured: true }), generate: async () => ({ text: "# Local fixture draft\nThis is not a live model response.",
    provider: "openai-compatible" as const, model: "local-fixture", usage: { inputTokens: 8, outputTokens: 12 },
    estimatedCostUsd: 0, durationMs: 0 }) } as unknown as Pick<TextModelRouter, "status" | "generate">;
  const gateway = new GenerationGateway(fixture, store, () => undefined, {});
  const jobs = new StudioJobs(gateway);
  const before = performance.now();
  const queued = jobs.submit({ modality: "text", format: "md", prompt: "Make a short sample" });
  metrics.acknowledgementMs = Number((performance.now() - before).toFixed(2));
  let completed = jobs.get(queued.id);
  for (let count = 0; count < 100 && completed?.status !== "COMPLETED"; count++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed = jobs.get(queued.id);
  }
  if (completed?.status !== "COMPLETED" || !store.read(completed.artifactId!)) throw new Error("Fixture artifact not saved.");
  metrics.firstSavedTextMs = Number((performance.now() - before).toFixed(2));
  const sources: Array<["docx" | "xlsx" | "pptx", string]> = [
    ["docx", "# Report\nA locally checked package."], ["xlsx", "title,value\nA,1"], ["pptx", "# Intro\nA title card"],
  ];
  const durations: Record<string, number> = {};
  for (const [format, source] of sources) {
    const begun = performance.now();
    await createOfficeExport(format, source);
    durations[format] = Number((performance.now() - begun).toFixed(2));
  }
  metrics.officeExportMs = durations;
  const png = new PNG({ width: 80, height: 60 }); png.data.fill(120);
  const image = store.save({ kind: "image", format: "png", bytes: PNG.sync.write(png), prompt: "Fixture frame",
    provider: "local-test-frame", model: "fixture" });
  const tone = store.save({ kind: "tone", format: "wav", bytes: synthesizeToneSequence("C4:1 E4:1", 120),
    prompt: "C4:1 E4:1", provider: "local-synthesizer", model: "test", estimatedCostUsd: 0 });
  metrics.localAudioSeconds = Number(tone.durationSeconds?.toFixed(2));
  const encoder = process.env.SARA_TEST_FFMPEG_PATH;
  if (encoder) {
    const beforeVideo = performance.now();
    const video = await new VideoRenderer(store, { SARA_FFMPEG_PATH: encoder }).render({ imageIds: [image.id], secondsPerImage: 1 });
    const saved = store.save({ kind: "video", format: "mp4", bytes: video, prompt: "Fixture clip", provider: "local-ffmpeg", model: "fixture" });
    metrics.localVideoMs = Number((performance.now() - beforeVideo).toFixed(2));
    metrics.localVideoBytes = saved.bytes;
  } else metrics.localVideo = "skipped; supply an opt-in local FFmpeg fixture path";
  const cpu = process.cpuUsage(startCpu);
  metrics.cpuUserMs = Number((cpu.user / 1000).toFixed(2));
  metrics.cpuSystemMs = Number((cpu.system / 1000).toFixed(2));
  metrics.rssStartMiB = Number((startRss / 1048576).toFixed(1));
  metrics.rssEndMiB = Number((process.memoryUsage().rss / 1048576).toFixed(1));
  metrics.note = "Single run on this host. No warmup, concurrency stress, billing, native Office or provider latency inference.";
  console.log(JSON.stringify(metrics, null, 2));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
