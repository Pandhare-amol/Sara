import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Gemini API keys are validated, atomically stored with private permissions, and never returned by status helpers", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-gemini-key-test-"));
  const oldDataDir = process.env.SARA_DATA_DIR;
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SARA_DATA_DIR = dataDir;
  delete process.env.GEMINI_API_KEY;

  try {
    const { clearGeminiApiKey, getGeminiApiKey, hasGeminiApiKey, setGeminiApiKey } = await import("../../server_paths");
    assert.equal(hasGeminiApiKey(), false);
    assert.equal(getGeminiApiKey(), undefined);
    assert.throws(() => setGeminiApiKey("invalid\nkey"), /invalid/i);
    assert.throws(() => setGeminiApiKey(""), /invalid/i);

    setGeminiApiKey("  test-gemini-secret  ");
    assert.equal(getGeminiApiKey(), "test-gemini-secret");
    assert.equal(hasGeminiApiKey(), true);
    const secretsPath = path.join(dataDir, "secrets.json");
    assert.ok(fs.existsSync(secretsPath));
    assert.equal(JSON.parse(fs.readFileSync(secretsPath, "utf8")).geminiApiKey, "test-gemini-secret");
    if (process.platform !== "win32") assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);

    clearGeminiApiKey();
    assert.equal(hasGeminiApiKey(), false);
  } finally {
    if (oldDataDir === undefined) delete process.env.SARA_DATA_DIR;
    else process.env.SARA_DATA_DIR = oldDataDir;
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldGeminiKey;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
