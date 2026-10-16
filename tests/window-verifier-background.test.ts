import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WindowVerifier } from "../src/core/tools/verification/windowVerifier";

// The verification fixture must use the same authenticated agent protocol as production.
process.env.SARA_AGENT_INTERNAL_TOKEN ||= "window-background-fixture-internal-token-0123456789";

test("a queued app launch is not verified by an unrelated empty-name window or a browser tab title", async () => {
  let windows: { title: string; application_name?: string; process_name?: string }[] = [];
  const server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ windows }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const verifier = new WindowVerifier(`http://127.0.0.1:${address.port}`);
  try {
    windows = [{ title: "Other application", application_name: "" }];
    assert.equal((await verifier.verify("openApplication", { name: "notepad" }, {})).verified, false);
    windows = [{ title: "Notepad tutorial - Chrome", application_name: "chrome.exe" }];
    assert.equal((await verifier.verify("openApplication", { name: "notepad" }, {})).verified, false);
    windows = [{ title: "Untitled - Notepad", application_name: "notepad.exe" }];
    assert.equal((await verifier.verify("openApplication", { name: "notepad" }, {})).verified, true);
    windows = [{ title: "Word report - Chrome", process_name: "chrome.exe" }];
    assert.equal((await verifier.verify("openApplication", { name: "word" }, {})).verified, false);
    windows = [{ title: "Report - Word", process_name: "WINWORD.EXE" }];
    assert.equal((await verifier.verify("openApplication", { name: "word" }, {})).verified, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
