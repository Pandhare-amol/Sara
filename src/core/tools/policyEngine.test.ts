import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./toolRegistry";
import { ToolPolicyEngine } from "./policyEngine";

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  value.registerRuntimeTools(["readFile", "sendMessage", "executePowerAction", "requestPowerAction", "desktopBrowserOpen"]);
  return value;
}

test("policy allows read-only tools without confirmation", () => {
  const result = new ToolPolicyEngine().evaluate("readFile", {}, registry());
  assert.equal(result.decision, "ALLOW");
});

test("policy asks before external side effects", () => {
  const result = new ToolPolicyEngine().evaluate("sendMessage", {}, registry());
  assert.equal(result.decision, "ASK_USER");
  assert.match(result.reason, /confirmation/i);
});

test("policy permits external side effects only with trusted internal context", () => {
  const result = new ToolPolicyEngine().evaluate("sendMessage", {}, registry(), { confirmed: true });
  assert.equal(result.decision, "ALLOW");
});

test("policy ignores consent-shaped fields in model or client arguments", () => {
  const result = new ToolPolicyEngine().evaluate("sendMessage", {
    confirmed: true,
    authorized: true,
    user_confirmed: true,
    policy_override: true,
  }, registry());
  assert.equal(result.decision, "ASK_USER");
});

test("policy denies browser domains outside the allowlist", () => {
  const result = new ToolPolicyEngine().evaluate(
    "desktopBrowserOpen",
    { url: "https://example.com" },
    registry(),
    { allowedDomains: ["youtube.com"] },
  );
  assert.equal(result.decision, "DENY");
});

test("power execution token does not itself count as human approval", () => {
  const policy = new ToolPolicyEngine();
  const result = policy.evaluate("executePowerAction", { execute_token: "token-from-request-tool" }, registry());
  assert.equal(result.decision, "ASK_USER");
  const approved = policy.evaluate("executePowerAction", { execute_token: "token-from-request-tool" }, registry(), { authorized: true });
  assert.equal(approved.decision, "ALLOW");
});
