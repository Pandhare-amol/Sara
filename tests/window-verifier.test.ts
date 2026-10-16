import test from "node:test";
import assert from "node:assert/strict";
import { WindowVerifier } from "../src/core/tools/verification/windowVerifier.ts";

process.env.SARA_AGENT_INTERNAL_TOKEN ||= "window-verifier-test-agent-token-0123456789abcdef";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

test("window verification sends the internal token to the agent", async () => {
  let receivedToken: string | null = null;
  const verifier = new WindowVerifier("http://127.0.0.1:8765", async (_input, init) => {
    receivedToken = new Headers(init?.headers).get("X-SARA-Agent-Token");
    return response({ windows: [{ title: "Notepad", application_name: "notepad" }] });
  });

  const result = await verifier.verify("openApplication", { name: "notepad" }, {});
  assert.equal(result.verified, true);
  assert.equal(receivedToken, process.env.SARA_AGENT_INTERNAL_TOKEN);
});

test("an unauthorized window query cannot be mistaken for a successful close", async () => {
  const verifier = new WindowVerifier("http://127.0.0.1:8765", async () => response({ detail: "unauthorized" }, 401));
  const result = await verifier.verify("closeWindow", { title: "Notepad" }, {});

  assert.equal(result.verified, false);
  assert.equal(result.checks.some((check) => check.name === "window_verification_error" && !check.passed), true);
});
