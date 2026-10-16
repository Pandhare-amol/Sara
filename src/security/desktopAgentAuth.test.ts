import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_AGENT_AUTH_PROTOCOL_VERSION,
  ensureDesktopAgentInternalToken,
  getDesktopAgentAuthHeaders,
  hasAuthenticatedDesktopAgentProtocol,
} from "./desktopAgentAuth";

test("managed agent launch gets a high-entropy process-scoped token without logging it", () => {
  const env: NodeJS.ProcessEnv = {};
  const token = ensureDesktopAgentInternalToken(env);

  assert.equal(Buffer.byteLength(token, "utf8") >= 32, true);
  assert.equal(env.SARA_AGENT_INTERNAL_TOKEN, token);
  assert.notEqual(token, ensureDesktopAgentInternalToken({}));
});

test("short configured internal tokens fail closed", () => {
  assert.throws(
    () => ensureDesktopAgentInternalToken({ SARA_AGENT_INTERNAL_TOKEN: "too-short" }),
    /at least 32 UTF-8 bytes/,
  );
});

test("loopback requests use only the internal agent token", () => {
  const headers = getDesktopAgentAuthHeaders("http://127.0.0.1:8765", {
    SARA_AGENT_INTERNAL_TOKEN: "internal-agent-test-token-0123456789abcdef",
    SARA_AGENT_ACCESS_TOKEN: "remote-agent-test-token-0123456789abcdef",
  }, "application/json");

  assert.equal(headers["X-SARA-Agent-Token"], "internal-agent-test-token-0123456789abcdef");
  assert.equal(headers["Content-Type"], "application/json");
});

test("remote agent requests require HTTPS and a separate remote token", () => {
  const env = {
    SARA_AGENT_INTERNAL_TOKEN: "internal-agent-test-token-0123456789abcdef",
    SARA_AGENT_ACCESS_TOKEN: "remote-agent-test-token-0123456789abcdef",
  };

  assert.throws(() => getDesktopAgentAuthHeaders("http://agent.example.test", env), /require HTTPS/);
  assert.equal(
    getDesktopAgentAuthHeaders("https://agent.example.test", env)["X-SARA-Agent-Token"],
    env.SARA_AGENT_ACCESS_TOKEN,
  );
});

test("agent health must advertise the authenticated protocol", () => {
  assert.equal(hasAuthenticatedDesktopAgentProtocol({
    agent_auth_required: true,
    agent_auth_protocol_version: DESKTOP_AGENT_AUTH_PROTOCOL_VERSION,
  }), true);
  assert.equal(hasAuthenticatedDesktopAgentProtocol({ status: "ok" }), false);
  assert.equal(hasAuthenticatedDesktopAgentProtocol({
    agent_auth_required: false,
    agent_auth_protocol_version: DESKTOP_AGENT_AUTH_PROTOCOL_VERSION,
  }), false);
});
