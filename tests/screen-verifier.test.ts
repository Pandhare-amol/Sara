import test from "node:test";
import assert from "node:assert/strict";
import { ScreenVerifier } from "../src/core/tools/verification/screenVerifier.ts";

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
  const requested: string[] = [];
  const verifier = new ScreenVerifier("http://desktop-agent.test", async (input) => {
    requested.push(String(input));
    return response({ ok: true, states: { "page-1": {
      ready: true,
      navigation_state: "complete",
      url: "https://example.com/docs",
    } } });
  });

  const result = await verifier.verify("desktopBrowserOpen", { url: "https://example.com/docs" }, { ok: true });
  assert.equal(result.verified, true);
  assert.deepEqual(requested, ["http://desktop-agent.test/browser/state"]);
  assert.equal((result.observedState?.page as any)?.url, "https://example.com/docs");
});

test("search verification requires the expected engine and query in the live page URL", async () => {
  const verifier = new ScreenVerifier("http://desktop-agent.test", async () => response({
    ok: true,
    states: { "page-1": { ready: true, navigation_state: "complete", url: "https://www.google.com/search?q=climate+data" } },
  }));
  const result = await verifier.verify("desktopBrowserSearch", { engine: "google", query: "climate data" }, { ok: true });
  assert.equal(result.verified, true);
});

test("a responsive browser on the wrong destination is not considered task success", async () => {
  const verifier = new ScreenVerifier("http://desktop-agent.test", async () => response({
    ok: true,
    states: { "page-1": { ready: true, navigation_state: "complete", url: "https://example.net/" } },
  }));
  const result = await verifier.verify("desktopBrowserOpen", { url: "https://example.com/" }, { ok: true });
  assert.equal(result.verified, false);
  assert.equal(result.checks.some((check) => check.name === "browser_target_postcondition" && !check.passed), true);
});
