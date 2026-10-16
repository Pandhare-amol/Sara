import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

async function freePort(): Promise<number> {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function waitForServer(base: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/models/status`)).ok) return; } catch { /* backend not yet listening */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated browser fixture backend did not start.");
}

// Optional real-browser acceptance. Does not require a real model, Docker, Office,
// network research, or user files; no browser executable is checked into Git.
test("desktop UI unlocks owner-only Studio, saves a real offline WAV, clears the token and labels learning honestly",
  { skip: !process.env.SARA_TEST_CHROMIUM_PATH, timeout: 110_000 }, async () => {
    assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "index.html")), "Run npm run build before the optional real-browser check.");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-studio-ui-"));
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const admin = randomBytes(32).toString("hex");
    let child: ChildProcess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    // A loopback-only, non-billable text provider unlocks the app's existing
    // first-run gate. This test never requests text generation or a real API.
    const localProvider = createServer((_req, res) => { res.writeHead(503); res.end("Fixture model does not generate text."); });
    await new Promise<void>((resolve) => localProvider.listen(0, "127.0.0.1", resolve));
    const providerAddress = localProvider.address();
    assert.ok(providerAddress && typeof providerAddress === "object");
    let output = "";
    try {
      child = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
          ...process.env, NODE_ENV: "production", PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1",
          SARA_DATA_DIR: dir, SARA_ADMIN_TOKEN: admin,
          SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "fixture-no-generation",
          SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
          SARA_TEXT_API_KEY: "fixture-only-not-a-credential",
          SARA_ENABLE_DOCKER_SANDBOX: "false", SARA_FFMPEG_PATH: "",
        },
      });
      child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-3000); });
      child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-3000); });
      await waitForServer(base);
      browser = await chromium.launch({ executablePath: process.env.SARA_TEST_CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.stack || error.message); });
      const loaded = await page.goto(base, { waitUntil: "domcontentloaded", timeout: 35_000 });
      try { await page.getByRole("button", { name: "Open creative studio" }).waitFor({ timeout: 12_000 }); }
      catch { throw new Error(`App did not render the CREATE control (HTTP ${loaded?.status()}; title ${await page.title()}; body ${JSON.stringify((await page.locator("body").innerText()).slice(0, 360))}; errors ${errors.slice(0, 3).join("; ")}).`); }
      // The legacy workspace opens the desktop chat flyout on first load;
      // close it through its accessible button before reaching CREATE.
      const closeChat = page.getByRole("button", { name: "Close chat" });
      if (await closeChat.isVisible()) await closeChat.click();
      await page.getByRole("button", { name: "Open creative studio" }).click();
      const studio = page.getByRole("dialog", { name: "Creative studio workspace" });
      await studio.getByText("Only validated, saved files appear as completed.", { exact: false }).waitFor();
      assert.equal(await studio.getByRole("textbox", { name: "Creation request" }).count(), 0,
        "An unapproved UI must not expose the creation controls.");
      await studio.locator('input[type="password"]').fill(admin);
      await studio.getByRole("button", { name: "Unlock creative workspace" }).click();
      await studio.getByRole("button", { name: "tone-sequence" }).click();
      await studio.getByText(/Configured, not guaranteed available/).waitFor({ timeout: 15_000 });
      await studio.getByRole("textbox", { name: "Creation request" }).fill("C4:1 D4:1 E4:1 R:1");
      await studio.getByRole("button", { name: "Approve provider request & create" }).click();
      await studio.getByText("tone-sequence · COMPLETED", { exact: false }).waitFor({ timeout: 20_000 });

      const list = await page.request.get(`${base}/api/studio/artifacts`, { headers: { "x-admin-token": admin } });
      assert.equal(list.status(), 200);
      assert.match(list.headers()["cache-control"] || "", /no-store/);
      const { artifacts } = await list.json() as { artifacts: Array<{ id: string; kind: string; format: string }> };
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].kind, "tone"); assert.equal(artifacts[0].format, "wav");
      const audio = await page.request.get(`${base}/api/studio/artifacts/${artifacts[0].id}/download`,
        { headers: { "x-admin-token": admin } });
      assert.equal(audio.status(), 200);
      const bytes = await audio.body();
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.ok(bytes.length > 10_000);

      await studio.getByRole("button", { name: "Close studio" }).click();
      await page.getByRole("button", { name: "Open creative studio" }).click();
      await studio.getByRole("button", { name: "Unlock creative workspace" }).waitFor();
      assert.equal(await studio.getByRole("textbox", { name: "Creation request" }).count(), 0,
        "Unmounting Studio must clear the in-memory owner token.");
      await studio.getByRole("button", { name: "Close studio" }).click();

      await page.getByRole("button", { name: "Open research and learning dashboard" }).click();
      const learn = page.getByRole("dialog", { name: /research|learning/i });
      await learn.locator('input[type="password"]').fill(admin);
      await learn.getByRole("button", { name: /Unlock/i }).click();
      await learn.getByText("off; no Docker execution claimed", { exact: false }).waitFor({ timeout: 15_000 });
      assert.equal(errors.length, 0, `Unexpected frontend JavaScript error(s): ${errors.join("; ")}`);
      await context.close();
    } catch (error) {
      throw new Error(`Browser acceptance failed: ${error instanceof Error ? error.message : String(error)}; backend tail: ${output.slice(-600)}`);
    } finally {
      await browser?.close().catch(() => {});
      child?.kill("SIGTERM");
      if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child?.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => localProvider.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
