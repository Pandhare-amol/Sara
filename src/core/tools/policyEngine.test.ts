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

test("policy permits explicitly confirmed external side effects", () => {
  const result = new ToolPolicyEngine().evaluate("sendMessage", {}, registry(), { confirmed: true });
  assert.equal(result.decision, "ALLOW");
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

test("a model-visible power token cannot replace trusted user approval", () => {
  const args = { execute_token: "token-from-preparation", confirmed: true, policy_override: true };
  assert.equal(new ToolPolicyEngine().evaluate("executePowerAction", args, registry()).decision, "ASK_USER");
  assert.equal(new ToolPolicyEngine().evaluate("executePowerAction", args, registry(), { confirmed: true }).decision, "ALLOW");
});

test("browser form submission and clicks need approval, ordinary fills do not", () => {
  const tools = registry();
  tools.registerRuntimeTools(["desktopBrowserFillForm", "desktopBrowserClick"]);
  const policy = new ToolPolicyEngine();
  assert.equal(policy.evaluate("desktopBrowserFillForm", { fields: { "#name": "Ada" } }, tools).decision, "ALLOW");
  assert.equal(policy.evaluate("desktopBrowserFillForm", { fields: { "#name": "Ada" }, submit: "#send" }, tools).decision, "ASK_USER");
  assert.equal(policy.evaluate("desktopBrowserClick", { selector: "#send" }, tools).decision, "ASK_USER");
});
