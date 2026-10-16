import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("TaskRunner cancels queued records but preserves active tasks as stop-requested", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-task-stop-"));
  const previousDataDir = process.env.SARA_DATA_DIR;
  process.env.SARA_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.SARA_DATA_DIR;
    else process.env.SARA_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const state = await import("../server_state.ts");
  const { TaskRunner } = await import("../server_task_manager.ts");
  const runner = new TaskRunner(async () => ({ ok: true }), false);
  runner.stop();

  const queued = await state.createTask({
    taskId: "queued-stop-test",
    conversationId: "stop-test",
    description: "queued task",
  });
  const active = await state.createTask({
    taskId: "active-stop-test",
    conversationId: "stop-test",
    description: "active task",
    status: "running",
  });
  (runner as any).activeTaskIds.add(active.taskId);

  const stop = await runner.emergencyStop();
  const records = await state.loadTasks();
  const queuedAfterStop = records.find((task) => task.taskId === queued.taskId);
  const activeAfterStop = records.find((task) => task.taskId === active.taskId);

  assert.deepEqual(stop.cancelledQueuedTaskIds, [queued.taskId]);
  assert.deepEqual(stop.cancellationRequestedTaskIds, [active.taskId]);
  assert.equal(queuedAfterStop?.status, "cancelled");
  assert.equal(activeAfterStop?.status, "running");
  assert.equal((activeAfterStop?.checkpoint as any)?.cancellation?.automaticReplay, false);
  assert.ok((activeAfterStop?.metadata as any)?.cancellationRequestedAt);
});
