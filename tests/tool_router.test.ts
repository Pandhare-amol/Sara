import test from "node:test";
import assert from "node:assert/strict";
import { ToolRouter } from "../src/core/tools/toolRouter.ts";


test("ToolRouter rejects unknown tools without execution", async () => {
  let executed = false;
  const router = new ToolRouter({ isKnownTool: (name) => name === "knownTool" });
  router.setAdapter(async () => {
    executed = true;
    return { ok: true, result: { status: "SUCCESS", verification_status: "VERIFIED", executed: true } };
  });

  const result = await router.execute("unknownTool", {});

  assert.equal(result.ok, false);
  assert.equal(executed, false);
  assert.equal((result.result as any).status, "FAILED");
  assert.equal((result.result as any).execution_status, "FAILED");
  assert.equal((result.result as any).verification_status, "SKIPPED");
});

test("ToolRouter refuses client flags on a newly discovered side-effect tool", async () => {
  let invoked = 0;
  const router = new ToolRouter({ isKnownTool: (name) => name === "sendMessage" });
  router.setAdapter(async () => { invoked++; return { ok: true }; });
  const rejected = await router.execute("sendMessage", { to: "recipient", confirmed: true, user_confirmed: true, policy_override: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "WAITING_FOR_APPROVAL");
  assert.equal(router.registry.getMetadata("sendMessage")?.riskLevel, "EXTERNAL_SIDE_EFFECT");
  assert.equal(invoked, 0);
  await router.execute("sendMessage", { to: "recipient", policy_override: true }, { confirmed: true });
  assert.equal(invoked, 1);
});

test("ToolRouter preserves the existing adapter result and adds canonical data", async () => {
  const router = new ToolRouter({ isKnownTool: () => true });
  router.setAdapter(async (tool, args) => ({
    ok: true,
    result: {
      status: "SUCCESS",
      execution_status: "SUCCESS",
      verification_status: "VERIFIED",
      tool,
      operation_id: "operation-test-1",
      executed: true,
      verified: true,
      data: args,
    },
  }));

  const result = await router.execute("readFile", { path: "issue.txt" });

  assert.equal(result.ok, true);
  assert.equal((result.canonical as any)?.status, "SUCCESS");
  assert.equal((result.canonical as any)?.verification_status, "VERIFIED");
  assert.equal((result.canonical as any)?.operation_id, "operation-test-1");
  assert.deepEqual((result.canonical as any)?.data, { path: "issue.txt" });
});
