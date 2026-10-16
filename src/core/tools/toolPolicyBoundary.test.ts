import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./toolRegistry";
import { ToolRouter } from "./toolRouter";
import { ExecutionOrchestrator } from "./execution/executionOrchestrator";
import { VerificationRegistry } from "./verification/verificationRegistry";

function sideEffectRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "sendMessage",
    owner: "desktop-agent",
    metadata: { riskLevel: "EXTERNAL_SIDE_EFFECT", requiresConfirmation: true },
  });
  return registry;
}

test("ToolRouter rejects request/model consent fields and does not forward them", async () => {
  let executionCount = 0;
  const router = new ToolRouter({ registry: sideEffectRegistry() });
  router.setAdapter(async () => {
    executionCount++;
    return { ok: true, result: { sent: true } };
  });

  const result = await router.execute("sendMessage", {
    text: "hello",
    confirmed: true,
    authorized: true,
    user_confirmed: true,
    policy_override: true,
  });

  assert.equal(result.error, "WAITING_FOR_APPROVAL");
  assert.equal(executionCount, 0);
});

test("ToolRouter strips consent-shaped fields before any low-risk downstream call", async () => {
  const registry = new ToolRegistry();
  registry.registerRuntimeTools(["readFile"]);
  let receivedArgs: Record<string, unknown> | undefined;
  const router = new ToolRouter({ registry });
  router.setAdapter(async (_tool, args) => {
    receivedArgs = args;
    return { ok: true, result: { content: "file" } };
  });

  await router.execute("readFile", {
    path: "notes.txt",
    confirmed: true,
    authorized: true,
    user_confirmed: true,
    policy_override: true,
  });

  assert.deepEqual(receivedArgs, { path: "notes.txt" });
});

test("high-risk compound tools default to approval-required metadata", () => {
  const registry = new ToolRegistry();
  registry.registerRuntimeTools(["runPythonScript", "saraVoiceExecuteCommand"]);
  const router = new ToolRouter({ registry });

  for (const tool of ["runPythonScript", "saraVoiceExecuteCommand"]) {
    const result = router.policyEngine.evaluate(tool, {}, registry);
    assert.equal(result.decision, "ASK_USER", `${tool} must require approval`);
  }
});

test("ToolRouter forwards a server-trusted approval as a downstream confirmation", async () => {
  let receivedArgs: Record<string, unknown> | undefined;
  const router = new ToolRouter({ registry: sideEffectRegistry() });
  router.setAdapter(async (_tool, args) => {
    receivedArgs = args;
    return { ok: true, result: { sent: true } };
  });

  await router.execute("sendMessage", {
    text: "hello",
    confirmed: false,
    authorized: true,
    user_confirmed: true,
    policy_override: true,
  }, { authorized: true, context: "admin-ui-approval" });

  assert.deepEqual(receivedArgs, { text: "hello", confirmed: true });
});

test("ExecutionOrchestrator ignores request/model consent fields before dispatch", async () => {
  let executionCount = 0;
  const router = new ToolRouter({ registry: sideEffectRegistry() });
  router.setAdapter(async () => {
    executionCount++;
    return { ok: true, result: { sent: true } };
  });
  const orchestrator = new ExecutionOrchestrator(router, new VerificationRegistry());

  const result = await orchestrator.executeWithVerification("sendMessage", {
    confirmed: true,
    authorized: true,
    user_confirmed: true,
    policy_override: true,
  });

  assert.equal(result.executionError?.code, "CONFIRMATION_REQUIRED");
  assert.equal(executionCount, 0);
});

test("ExecutionOrchestrator passes trusted internal approval context to the router", async () => {
  let receivedArgs: Record<string, unknown> | undefined;
  const router = new ToolRouter({ registry: sideEffectRegistry() });
  router.setAdapter(async (_tool, args) => {
    receivedArgs = args;
    return { ok: true, result: { sent: true } };
  });
  const orchestrator = new ExecutionOrchestrator(router, new VerificationRegistry());

  await orchestrator.executeWithVerification("sendMessage", { text: "approved" }, {
    policy: { authorized: true, context: "admin-ui-approval" },
    enableVerification: false,
  });

  assert.equal(receivedArgs?.text, "approved");
  assert.equal(receivedArgs?.confirmed, true);
  assert.equal(receivedArgs?.authorized, undefined);
  assert.equal(receivedArgs?.user_confirmed, undefined);
  assert.equal(receivedArgs?.policy_override, undefined);
});
