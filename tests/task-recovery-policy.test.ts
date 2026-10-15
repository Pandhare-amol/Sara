import test from "node:test";
import assert from "node:assert/strict";
import { buildInterruptedTaskPatch } from "../src/core/taskRecovery";

test("interrupted in-flight tasks become paused without losing checkpoints", () => {
  const checkpoint = { step: 3, completedSteps: ["scan"], progress: { file: "draft.md" } };
  const metadata = { tool: "desktopBrowserClick", source: "user" };
  const patch = buildInterruptedTaskPatch(
    { taskId: "task-1", status: "running", checkpoint, metadata },
    "2026-10-14T10:00:00.000Z",
  );

  assert.ok(patch);
  assert.equal(patch.status, "paused");
  assert.equal(patch.updatedAt, "2026-10-14T10:00:00.000Z");
  assert.deepEqual(patch.checkpoint.step, 3);
  assert.deepEqual(patch.checkpoint.completedSteps, ["scan"]);
  assert.equal((patch.checkpoint.recovery as any).automaticReplay, false);
  assert.equal((patch.checkpoint.recovery as any).checkpointPreserved, true);
  assert.equal(patch.metadata.tool, "desktopBrowserClick");
  assert.equal((patch.metadata.lastInterruption as any).interruptedStatus, "running");
  assert.match(patch.error, /not replayed/i);
});

test("only interrupted in-flight states are paused at startup", () => {
  for (const status of ["planning", "RECOVERING", "retrying"]) {
    assert.equal(buildInterruptedTaskPatch({ taskId: "task-2", status })?.status, "paused");
  }
  for (const status of ["queued", "waiting", "paused", "awaiting_confirmation", "completed", "failed", "cancelled"]) {
    assert.equal(buildInterruptedTaskPatch({ taskId: "task-3", status }), null);
  }
});
