import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { PNG } from "pngjs";
import { ArtifactStore } from "../../src/core/studio/artifactStore";

async function port() { const server = createServer((_, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Isolated local video HTTP fixture timed out.");
}

test("HTTP video assembly saves a decodable local MP4 from private PNGs and protected mode denies download", {
  skip: !process.env.SARA_TEST_FFMPEG_PATH ? "No opt-in reviewed local FFmpeg fixture" : false,
  timeout: 50_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-video-http-"));
  const admin = "local-video-http-fixture-admin-secret-long-enough";
  let child: ChildProcess | undefined; let logs = "";
  try {
    const store = new ArtifactStore(path.join(root, "studio"));
    const frame = (red: number) => { const png = new PNG({ width: 80, height: 60 });
      for (let index = 0; index < png.data.length; index += 4) {
        png.data[index] = red; png.data[index + 1] = 100; png.data[index + 2] = 50; png.data[index + 3] = 255;
      } return PNG.sync.write(png); };
    const slides = [50, 160].map((red) => store.save({ kind: "image", format: "png", prompt: `Frame ${red}`,
      bytes: frame(red), provider: "local-test-frame", model: "fixture" }));
    const base = `http://127.0.0.1:${await port()}`;
    child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], { cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SARA_DATA_DIR: root, SARA_ADMIN_TOKEN: admin,
        SARA_BIND_HOST: "127.0.0.1", PORT: base.split(":").at(-1), SARA_SUPERVISOR: "1",
        GEMINI_API_KEY: "", OPENAI_API_KEY: "", SARA_FFMPEG_PATH: process.env.SARA_TEST_FFMPEG_PATH,
        SARA_AUTO_MEMORY: "false" },
    });
    child.stdout?.on("data", (chunk) => { logs += String(chunk).slice(0, 800); });
    child.stderr?.on("data", (chunk) => { logs += String(chunk).slice(0, 800); });
    const call = async (route: string, method = "GET", body?: unknown, authorized = true) => {
      const response = await fetch(base + route, { method, headers: {
        ...(authorized ? { "x-admin-token": admin } : {}), ...(body ? { "content-type": "application/json" } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    };
    await until(async () => (await fetch(base + "/api/models/status")).ok);
    const capabilities = await call("/api/studio/capabilities");
    assert.equal(capabilities.body.capabilities.find((item: any) => item.modality === "video-assembly").configured, true);
    assert.equal((await call("/api/studio/jobs", "POST", { modality: "video-assembly", format: "mp4", prompt: "Two-image cut",
      video: { imageIds: slides.map((slide) => slide.id), secondsPerImage: 1 } }, true)).status, 400);
    const submitted = await call("/api/studio/jobs", "POST", { modality: "video-assembly", format: "mp4", prompt: "Two-image cut",
      video: { imageIds: slides.map((slide) => slide.id), secondsPerImage: 1 }, confirm: true });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body) + logs.slice(-300));
    const id = submitted.body.job.id as string;
    await until(async () => ["COMPLETED", "FAILED"].includes((await call(`/api/studio/jobs/${id}`)).body.job?.status), 25_000);
    const result = await call(`/api/studio/jobs/${id}`);
    assert.equal(result.body.job.status, "COMPLETED", JSON.stringify(result.body) + logs.slice(-400));
    const artifact = store.read(result.body.job.artifactId);
    // The running backend has its own in-memory history; reopen the private manifest.
    const completed = new ArtifactStore(path.join(root, "studio")).read(result.body.job.artifactId);
    assert.equal(artifact, undefined);
    assert.ok(completed && completed.bytes.length > 1_000);
    assert.equal(completed.item.kind, "video");
    assert.ok((completed.item.durationSeconds || 0) >= 1.5);
    assert.equal((await call(`/api/studio/artifacts/${completed.item.id}/download`, "GET", undefined, false)).status, 403);
    assert.equal((await call("/api/users/bootstrap", "POST", { displayName: "Owner", adminSecret: admin }, false)).status, 201);
    assert.equal((await call(`/api/studio/artifacts/${completed.item.id}/download`)).status, 403);
  } finally {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(); child.once("exit", () => resolve()); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
