import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

async function freePort() {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function until(check: () => Promise<boolean>, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* fixture starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated evidence browser fixture timed out.");
}

// Run only after npm run build with a disposable, reviewed local Chromium binary.
// A pre-seeded *fixture* research record tests UI contracts, not live retrieval.
test("existing Projects UI links fixture research, a real offline WAV and explicit human-only acceptance",
  { skip: !process.env.SARA_TEST_CHROMIUM_PATH, timeout: 110_000 }, async () => {
    assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "index.html")), "Build production assets before browser acceptance.");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-evidence-browser-"));
    const admin = randomBytes(32).toString("hex"), sourceId = randomUUID(), taskId = randomUUID();
    const source = { id: sourceId, url: "https://example.com/fixture-evidence", title: "Browser fixture source",
      retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update("fixture-not-web-evidence").digest("hex"),
      passages: ["Local data for exercising the UI, not a live researched fact."],
      status: "retrieved_unverified", sourceType: "web_document" };
    fs.mkdirSync(path.join(root, "research"), { recursive: true });
    fs.writeFileSync(path.join(root, "research", "jobs.json"), JSON.stringify({ schema: 1, jobs: [{
      id: taskId, question: "Fixture provenance for the UI", urls: [source.url], status: "COMPLETED",
      sources: [source], failures: [], findingsStatus: "unresolved", finishedAt: new Date().toISOString(),
    }], dailyUsage: [] }), { mode: 0o600 });
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, output = "";
    try {
      child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
          ...process.env, NODE_ENV: "production", PORT: String(port), SARA_BIND_HOST: "127.0.0.1",
          SARA_SUPERVISOR: "1", SARA_DATA_DIR: root, SARA_ADMIN_TOKEN: admin, GEMINI_API_KEY: "",
          SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fixture-not-connected",
          SARA_TEXT_API_BASE_URL: "http://127.0.0.1:9/v1", SARA_TEXT_API_KEY: "fixture-only",
          SARA_ENABLE_DOCKER_SANDBOX: "false",
        },
      });
      child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-900); });
      child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-900); });
      await until(async () => (await fetch(base + "/api/models/status")).ok);
      browser = await chromium.launch({ executablePath: process.env.SARA_TEST_CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); });
      page.on("dialog", (dialog) => { void dialog.accept(); });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Open project manager" }).waitFor({ timeout: 12_000 });
      const closeChat = page.getByRole("button", { name: "Close chat" });
      await closeChat.waitFor({ timeout: 4000 }).catch(() => { /* Some installations do not auto-open chat. */ });
      if (await closeChat.isVisible()) await closeChat.click();
      const projectResponse = await page.request.post(base + "/api/projects", { data: { title: "Evidence acceptance fixture" } });
      assert.equal(projectResponse.status(), 201);
      const project = (await projectResponse.json() as { project: { id: string } }).project;
      await page.getByRole("button", { name: "Open project manager" }).click();
      const manager = page.getByRole("dialog", { name: /Projects & tasks/i });
      await manager.getByRole("button", { name: /Evidence acceptance fixture/ }).click();
      await manager.getByRole("button", { name: "Open evidence-backed workflow" }).click();
      const board = page.getByRole("dialog", { name: "Evidence-backed project workflow" });
      await board.getByText("This is not a fact checker", { exact: false }).waitFor();
      assert.equal(await board.getByRole("button", { name: "Create evidence board" }).count(), 0,
        "Owner-only board controls must be hidden until the token is supplied.");
      await board.locator('input[type="password"]').fill(admin);
      await board.getByRole("button", { name: "Unlock evidence board" }).click();
      await board.getByText(/Release index: BLOCKED/).waitFor({ timeout: 15_000 });
      await board.getByRole("button", { name: "Create evidence board" }).click();
      await board.getByText("Current checkpoint: DRAFT").waitFor();
      await board.getByRole("combobox", { name: "Select completed research task" }).selectOption(taskId);
      await board.getByRole("checkbox", { name: /Browser fixture source/ }).check();
      await board.getByRole("button", { name: "Link selected source IDs" }).click();
      await board.getByRole("textbox", { name: "Human-authored project brief" }).fill(
        "I inspected the local fixture passage, but no live source or independent fact check was performed.");
      await board.getByRole("button", { name: "Save new brief revision" }).click();
      await board.getByRole("checkbox", { name: /I read these sources/ }).check();
      await board.getByRole("button", { name: /Review exact brief/ }).click();
      await board.getByText("Current checkpoint: BRIEF_REVIEWED").waitFor();

      // Create a real file via the existing backend Studio route, not a fake UI response.
      const headers = { "x-admin-token": admin };
      const tone = await page.request.post(base + "/api/studio/jobs", { headers,
        data: { modality: "tone-sequence", format: "wav", prompt: "C4:1 D4:1 E4:1 R:1", bpm: 120, confirm: true } });
      assert.equal(tone.status(), 202);
      const jobId = (await tone.json() as { job: { id: string } }).job.id;
      await until(async () => (await (await page.request.get(base + `/api/studio/jobs/${jobId}`, { headers })).json() as { job: { status: string } }).job.status === "COMPLETED");
      const artifactId = (await (await page.request.get(base + `/api/studio/jobs/${jobId}`, { headers })).json() as
        { job: { artifactId: string } }).job.artifactId;
      await board.getByRole("button", { name: "Refresh checked state" }).click();
      await board.getByRole("combobox", { name: "Select Studio job" }).selectOption(jobId);
      await board.getByRole("button", { name: "Link job", exact: true }).click();
      await board.getByRole("combobox", { name: "Select saved Studio file" }).selectOption(artifactId);
      await board.getByRole("button", { name: "Link saved file" }).click();
      await board.getByText("Current checkpoint: AWAITING_FINAL_REVIEW").waitFor();
      await board.getByRole("checkbox", { name: /I inspected all linked saved files/ }).check();
      await board.getByRole("button", { name: "Accept exact saved artifacts for manual use" }).click();
      await board.getByText("Current checkpoint: HUMAN_ACCEPTED").waitFor();
      const download = page.waitForEvent("download");
      await board.getByRole("button", { name: /Export private JSON manifest/ }).click();
      assert.match((await download).suggestedFilename(), /project-evidence-.*\.json/);
      const verified = await page.request.get(base + `/api/projects/${project.id}/evidence`, { headers });
      assert.equal((await verified.json() as { report: { phase: string } }).report.phase, "HUMAN_ACCEPTED");
      const boardUrl = `**/api/projects/${project.id}/evidence`;
      await page.route(boardUrl, async (route) => route.request().method() === "GET"
        ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Isolated fixture interruption"}' })
        : route.continue());
      await board.getByRole("button", { name: "Refresh checked state" }).click();
      await board.getByText("Last-known checkpoint: HUMAN_ACCEPTED").waitFor();
      assert.equal(await board.getByRole("button", { name: "Accept exact saved artifacts for manual use" }).isDisabled(), true,
        "A failed fresh check must not present last-known acceptance as actionable.");
      await page.unroute(boardUrl);
      await board.getByRole("button", { name: "Refresh checked state" }).click();
      await board.getByText("Current checkpoint: HUMAN_ACCEPTED").waitFor();
      const changedProject = await page.request.patch(base + `/api/projects/${project.id}`, {
        data: { title: "Changed title needs fresh review", description: "Updated details in the local project" },
      });
      assert.equal(changedProject.status(), 200);
      await board.getByRole("button", { name: "Refresh checked state" }).click();
      await board.getByText("Current checkpoint: STALE").waitFor();
      await board.getByText("Title: Changed title needs fresh review").waitFor();
      await board.getByText("Description: Updated details in the local project").waitFor();
      await board.getByRole("button", { name: "Review changed project details & rebind" }).click();
      await board.getByText("Current checkpoint: DRAFT").waitFor();
      assert.equal(await board.getByRole("button", { name: "Accept exact saved artifacts for manual use" }).isDisabled(), true);
      await board.getByRole("checkbox", { name: /I read these sources/ }).check();
      await board.getByRole("button", { name: /Review exact brief/ }).click();
      await board.getByRole("checkbox", { name: /I inspected all linked saved files/ }).check();
      await board.getByRole("button", { name: "Accept exact saved artifacts for manual use" }).click();
      await board.getByText("Current checkpoint: HUMAN_ACCEPTED").waitFor();
      await board.getByRole("button", { name: "Close evidence board" }).click();
      await manager.getByRole("button", { name: "Open evidence-backed workflow" }).click();
      await board.getByRole("button", { name: "Unlock evidence board" }).waitFor();
      assert.equal(await board.getByRole("button", { name: "Accept exact saved artifacts for manual use" }).count(), 0,
        "Closing the board must clear its owner token without losing the private ledger.");
      await board.locator('input[type="password"]').fill(admin);
      await board.getByRole("button", { name: "Unlock evidence board" }).click();
      await board.getByText("Current checkpoint: HUMAN_ACCEPTED").waitFor();
      // A private 200 response received before revocation must not rehydrate
      // the panel if another check discovers protected mode first.
      const cached = await page.request.get(base + "/api/studio/artifacts", { headers });
      assert.equal(cached.status(), 200);
      const cachedBody = await cached.text();
      let holdStarted!: () => void, releaseHeld!: () => void, holdDone!: () => void;
      const started = new Promise<void>((resolve) => { holdStarted = resolve; });
      const done = new Promise<void>((resolve) => { holdDone = resolve; });
      let holding = false;
      await page.route("**/api/studio/artifacts", async (route) => {
        if (holding) return route.continue();
        holding = true; holdStarted();
        await new Promise<void>((resolve) => { releaseHeld = resolve; });
        await route.fulfill({ status: 200, contentType: "application/json", body: cachedBody });
        holdDone();
      });
      await board.getByRole("button", { name: "Refresh checked state" }).click();
      await started;
      const protectedMode = await page.request.post(base + "/api/users/bootstrap", { data: { adminSecret: admin, displayName: "Owner" } });
      assert.equal(protectedMode.status(), 201);
      await board.getByRole("button", { name: "Unlock evidence board" }).waitFor({ timeout: 15_000 });
      releaseHeld(); await done;
      await page.waitForTimeout(300);
      assert.equal(await board.getByText("Current checkpoint: HUMAN_ACCEPTED").count(), 0,
        "An older owner response must never restore private UI details after protected-mode revocation.");
      assert.deepEqual(errors, [], `No frontend runtime error expected: ${errors.join("; ")}`);
      await context.close();
    } catch (error) {
      throw new Error(`Evidence browser acceptance failed: ${error instanceof Error ? error.message : String(error)}; backend: ${output}`);
    } finally {
      await browser?.close().catch(() => {});
      child?.kill("SIGTERM");
      if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child?.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
