import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MusicQualityAnalyzer } from "../src/services/music_studio/quality_analyzer";
import { UnavailableMusicProvider, musicProviderRegistry } from "../src/services/music_studio/provider_registry";

test("production provider health is truthful when no music engine is configured", async () => {
  const health = await musicProviderRegistry.health();
  assert.deepEqual(health, [{ id: "unavailable", healthy: false, details: "No production music generation provider is configured." }]);
  await assert.rejects(() => new UnavailableMusicProvider().generateMusic({ projectId: "p", brief: {} as any, lyrics: "", compositionPlan: {} }), /MUSIC_PROVIDER_UNAVAILABLE/);
});

test("quality analyzer rejects missing and corrupt media artifacts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sara-music-quality-"));
  const artifact = path.join(directory, "corrupt.bin");
  await fs.writeFile(artifact, "not audio", "utf8");
  const report = await new MusicQualityAnalyzer().verifyArtifact(artifact);
  assert.equal(report.passed, false);
  assert.ok(report.checks.some((check) => check.name === "decodable_container" && !check.passed));
});