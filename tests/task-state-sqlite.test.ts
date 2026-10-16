import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set the store path BEFORE importing server_state: its paths are module constants.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-task-state-"));
process.env.SARA_DATA_DIR = dir;
const state = await import("../server_state");

test("existing task store writes and deletes from SQLite without resurrecting deleted records", async () => {
  try {
    // A legacy JSON-only installation must not lose tasks when SQLite first appears.
    const legacy = { taskId: "legacy-json", conversationId: "demo", description: "Old saved task", status: "paused", priority: 5,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), retryCount: 0 };
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([legacy]));
    const bridge = await state.initSqlBridge();
    assert.ok(bridge?.db, "SQL bridge should initialize from an empty directory");
    assert.ok((await state.loadTasks()).some((task) => task.taskId === legacy.taskId));
    const created = await state.createTask({ conversationId: "demo", description: "Test the safe task store." });
    assert.ok((await state.loadTasks()).some((task) => task.taskId === legacy.taskId));
    assert.equal((await state.loadTasks()).find((task) => task.taskId === created.taskId)?.status, "queued");
    await state.updateTask(created.taskId, { status: "running" });
    assert.equal((await state.loadTasks()).find((task) => task.taskId === created.taskId)?.status, "running");
    assert.equal(await state.deleteTask(created.taskId), true);
    assert.equal((await state.loadTasks()).find((task) => task.taskId === created.taskId), undefined);
    assert.equal(await state.deleteTask(legacy.taskId), true);
    assert.equal(bridge.db.exec("SELECT COUNT(*) FROM tasks")[0].values[0][0], 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
