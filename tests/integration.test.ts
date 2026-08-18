import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { isPortHealthy, startService, stopAll, evaluateLockPid, applyHealthState } from "../startup/processGuard.ts";
import { overallServiceState } from "../startup/startupState.ts";
import { createTask, updateTask, type TaskRecord } from "../server_state.ts";
import { buildStructuredExecutionResult } from "../server_task_manager.ts";
import { createUserResponseFromResult } from "../src/types/AuthoritativeTaskResult.ts";

test("Backend - startup, health, identity, and adoption", async () => {
  const port = 3001; // use alternative port for test
  
  // start backend using real startService
  const backend = await startService({
    name: "TestBackend",
    port,
    healthPath: "/health",
    expectedServiceId: "sara-backend",
    command: "npx",
    args: ["tsx", "server_full.ts"],
    cwd: process.cwd(),
    env: {
      NODE_ENV: "development",
      PORT: String(port)
    },
    waitMs: 15_000,
  });

  assert.equal(backend.healthy, true, "Backend should start and be healthy");
  assert.equal(backend.adopted, false, "First start should not be adopted");

  // check health identity
  const res = await isPortHealthy(port, "/health");
  assert.equal(res.healthy, true, "isPortHealthy should return true");
  assert.equal(res.data?.service, "sara-backend", "Identity should be sara-backend");

  // attempt adoption
  const adoptedBackend = await startService({
    name: "TestBackend",
    port,
    healthPath: "/health",
    expectedServiceId: "sara-backend",
    command: "npx",
    args: ["tsx", "server_full.ts"],
    cwd: process.cwd(),
    env: { PORT: String(port) },
    waitMs: 5000,
  });

  assert.equal(adoptedBackend.healthy, true, "Should still be healthy");
  assert.equal(adoptedBackend.adopted, true, "Should adopt existing service");

  // try to adopt with wrong identity
  const foreignBackend = await startService({
    name: "TestForeignBackend",
    port,
    healthPath: "/health",
    expectedServiceId: "sara-foreign",
    command: "npx",
    args: ["tsx", "server_full.ts"],
    cwd: process.cwd(),
    env: { PORT: String(port) },
    waitMs: 2000,
  });

  assert.equal(foreignBackend.healthy, false, "Should reject foreign service identity");

  stopAll();
});

test("Desktop Agent - startup, health, identity, and adoption", async () => {
  const port = 8766; // alternative port
  const agent = await startService({
    name: "TestAgent",
    port,
    healthPath: "/health",
    expectedServiceId: "sara-desktop-agent",
    command: "python",
    args: ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", String(port)],
    cwd: process.cwd(),
    waitMs: 25_000,
  });

  assert.equal(agent.healthy, true, "Desktop Agent should start and be healthy");
  assert.equal(agent.adopted, false, "Should not be adopted initially");

  // check capability
  const capRes = await isPortHealthy(port, "/capabilities");
  assert.equal(capRes.healthy, true, "Capabilities endpoint should respond");
  assert.equal(capRes.data?.status, "PROCESS_HEALTHY", "Should report PROCESS_HEALTHY");

  // adoption
  const adoptedAgent = await startService({
    name: "TestAgent",
    port,
    healthPath: "/health",
    expectedServiceId: "sara-desktop-agent",
    command: "python",
    args: ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", String(port)],
    cwd: process.cwd(),
    waitMs: 5000,
  });
  
  assert.equal(adoptedAgent.healthy, true, "Should be healthy");
  assert.equal(adoptedAgent.adopted, true, "Should adopt existing agent");

  stopAll();
});

test("Startup - Unify service states", () => {
  const overall1 = overallServiceState({
    supervisor: { name: "supervisor", state: "HEALTHY", healthy: true },
    backend: { name: "backend", state: "ADOPTED", healthy: true, adopted: true },
    desktop_agent: { name: "desktop_agent", state: "HEALTHY", healthy: true, adopted: false },
  });
  assert.equal(overall1, "HEALTHY");

  const overall2 = overallServiceState({
    supervisor: { name: "supervisor", state: "HEALTHY", healthy: true },
    backend: { name: "backend", state: "FAILED", healthy: false },
    desktop_agent: { name: "desktop_agent", state: "HEALTHY", healthy: true },
  });
  assert.equal(overall2, "DEGRADED");
});

test("Health supervisor tolerates transient false negatives before marking a service unhealthy", () => {
  const handle = { name: "Desktop Agent", healthy: true, retries: 0, adopted: false, consecutiveFailures: 0 } as any;

  const firstMiss = applyHealthState(handle, false, 2);
  assert.equal(firstMiss.healthy, true, "A single missed ping should not flip the service to unhealthy");
  assert.equal(firstMiss.consecutiveFailures, 1, "The health failure counter should increment");

  const secondMiss = applyHealthState(handle, false, 2);
  assert.equal(secondMiss.healthy, false, "The service should become unhealthy only after repeated failures");
  assert.equal(secondMiss.consecutiveFailures, 2, "The second failure should trigger the unhealthy threshold");

  const restored = applyHealthState(handle, true, 2);
  assert.equal(restored.healthy, true, "A successful health check should restore healthy state");
  assert.equal(restored.consecutiveFailures, 0, "The failure counter should reset on recovery");
});

test("Task state cannot regress after final success", async () => {
  const task = await createTask({ conversationId: "test-regression", description: "copy report.txt to reports folder" });

  const success = await updateTask(task.taskId, {
    status: "completed",
    result: JSON.stringify({ success: true, status: "succeeded", verified: true }),
    completedAt: new Date().toISOString(),
  });

  assert.equal(success?.status, "completed");

  const stale = await updateTask(task.taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  assert.equal(stale?.status, "completed");
  assert.equal(Boolean(stale?.result), true);
});

test("Task execution must require verification before reporting success", () => {
  const result = buildStructuredExecutionResult(
    "task-verify-required",
    "copy report.txt to reports folder",
    new Date().toISOString(),
    "copyFile",
    { source: "report.txt", destination: "reports/report.txt" },
    { ok: true, result: { copied: true } },
    { attempted: true, verified: false, method: "file_check", details: "The file was not found after the tool call." }
  );

  assert.equal(result.success, false);
  assert.equal(result.state, "FAILED");
  assert.equal(result.verified, false);
  assert.equal(createUserResponseFromResult(result), "I couldn't complete the task. The file was not found after the tool call.");
});
