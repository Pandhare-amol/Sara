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

test("power execution accepts the existing single-use token flow", () => {
  const result = new ToolPolicyEngine().evaluate(
    "executePowerAction",
    { execute_token: "token-from-confirmation" },
    registry(),
  );
  assert.equal(result.decision, "ALLOW");
});
