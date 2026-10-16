import test from "node:test";
import assert from "node:assert/strict";
import { ScreenVerifier } from "../src/core/tools/verification/screenVerifier.ts";

process.env.SARA_AGENT_INTERNAL_TOKEN ||= "screen-verifier-test-agent-token-0123456789abcdef";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

test("screen verifier returns verified capture evidence for a real artifact payload", async () => {
  const verifier = new ScreenVerifier();
  const result = await verifier.verify("takeScreenshot", {}, {
    screenshot_id: "screen-test-1",
    width: 1366,
    height: 768,
  });

  assert.equal(result.verified, true);
  assert.equal(result.method, "screen");
  assert.equal(result.observedState?.screenshotId, "screen-test-1");
  assert.deepEqual(result.observedState?.dimensions, { width: 1366, height: 768 });
});

test("browser navigation is independently checked against the live browser-state endpoint", async () => {
  const requested: Array<{ url: string; token: string | null }> = [];
  const verifier = new ScreenVerifier("http://127.0.0.1:8765", async (input, init) => {
    requested.push({
      url: String(input),
      token: new Headers(init?.headers).get("X-SARA-Agent-Token"),
    });
    return response({ ok: true, states: { "page-1": {
      ready: true,
      navigation_state: "complete",
      url: "https://example.com/docs",
    } } });
  });

  const result = await verifier.verify("desktopBrowserOpen", { url: "https://example.com/docs" }, { ok: true });
  assert.equal(result.verified, true);
  assert.deepEqual(requested, [{
    url: "http://127.0.0.1:8765/browser/state",
    token: process.env.SARA_AGENT_INTERNAL_TOKEN,
  }]);
  assert.equal((result.observedState?.page as any)?.url, "https://example.com/docs");
});

test("search verification requires the expected engine and query in the live page URL", async () => {
  const verifier = new ScreenVerifier("http://127.0.0.1:8765", async () => response({
    ok: true,
    states: { "page-1": { ready: true, navigation_state: "complete", url: "https://www.google.com/search?q=climate+data" } },
  }));
  const result = await verifier.verify("desktopBrowserSearch", { engine: "google", query: "climate data" }, { ok: true });
  assert.equal(result.verified, true);
});

test("a responsive browser on the wrong destination is not considered task success", async () => {
  const verifier = new ScreenVerifier("http://127.0.0.1:8765", async () => response({
    ok: true,
    states: { "page-1": { ready: true, navigation_state: "complete", url: "https://example.net/" } },
  }));
  const result = await verifier.verify("desktopBrowserOpen", { url: "https://example.com/" }, { ok: true });
  assert.equal(result.verified, false);
  assert.equal(result.checks.some((check) => check.name === "browser_target_postcondition" && !check.passed), true);
});
