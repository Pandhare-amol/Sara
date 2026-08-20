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
