import assert from "node:assert/strict";
import test from "node:test";
import { initializeToolExecution } from "./initialization";
import { ToolRouter } from "./toolRouter";

const APP_TOOLS = ["saraAppExecuteGoal", "saraVoiceExecuteCommand", "closeLaunchedApplications"];
const REGISTERED_TOOLS = [...APP_TOOLS, "saraAgentEmergencyStop"];

test("app and voice task results require explicit ok and verified fields", async () => {
  const toolRouter = new ToolRouter({ isKnownTool: (tool) => REGISTERED_TOOLS.includes(tool) });
  toolRouter.registry.registerRuntimeTools(REGISTERED_TOOLS);
  toolRouter.registry.register({
    name: "saraAppExecuteGoal",
    owner: "desktop-agent",
    metadata: { riskLevel: "EXTERNAL_SIDE_EFFECT", requiresConfirmation: true },
  });
  toolRouter.registry.register({
    name: "saraVoiceExecuteCommand",
    owner: "desktop-agent",
    metadata: { riskLevel: "DESTRUCTIVE_SYSTEM", requiresConfirmation: true },
  });

  const outcomes: Record<string, unknown> = {
    saraAppExecuteGoal: { ok: true, verified: true, auto_close_after_task: true },
    saraVoiceExecuteCommand: { ok: true, verified: true, auto_close_after_task: true },
    closeLaunchedApplications: { ok: true, verified: true, closed: [{ pid: 41 }], left_open: [] },
    saraAgentEmergencyStop: { ok: true, verified: true, status: "stop_requested", message: "Stop accepted." },
  };
  toolRouter.setAdapter(async (tool) => ({ ok: true, result: outcomes[tool] }));

  const orchestrator = initializeToolExecution(toolRouter);
  for (const tool of APP_TOOLS) {
    const result = await orchestrator.executeWithVerification(tool, {}, {
      policy: { authorized: true, context: "test-admin-approval" },
    });
    assert.equal(result.success, true, `${tool} should pass explicit app verification`);
    assert.equal(result.verified, true);
    assert.equal(result.verificationMethod, "application");
    assert.equal(result.status, "success");
  }

  outcomes.saraAppExecuteGoal = { ok: true, verified: false, auto_close_after_task: false };
  const unverified = await orchestrator.executeWithVerification("saraAppExecuteGoal", {}, {
    policy: { authorized: true, context: "test-admin-approval" },
  });
  assert.equal(unverified.success, false);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.verificationStatus, "failed");
  assert.equal(unverified.status, "failed");

  const stop = await orchestrator.executeWithVerification("saraAgentEmergencyStop", {});
  assert.equal(stop.success, true);
  assert.equal(stop.verified, true);
  assert.equal(stop.verificationMethod, "safety");
  assert.equal(stop.status, "success");
});
