import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStub } from "./desktop_agent_stub.js";

const testAgentToken = "test-only-agent-internal-secret-0123456789abcdef";
let stubServer;
let appProcess;
let testDataDir;

async function waitForUrl(url, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

test.beforeAll(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), "sara-voice-approval-e2e-"));
  stubServer = await startStub(8765, testAgentToken);
  appProcess = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server_full.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: "3000",
      SARA_BIND_HOST: "127.0.0.1",
      SARA_DATA_DIR: testDataDir,
      SARA_ADMIN_TOKEN: "test-only-admin-token",
      SARA_AGENT_INTERNAL_TOKEN: testAgentToken,
      DESKTOP_AGENT_URL: "http://127.0.0.1:8765",
    },
  });
  appProcess.stdout?.on("data", () => {});
  appProcess.stderr?.on("data", () => {});
  await waitForUrl("http://127.0.0.1:3000/api/agent-health");
});

test.afterAll(async () => {
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill("SIGTERM");
    await new Promise((resolve) => appProcess.once("exit", resolve));
  }
  if (stubServer) await new Promise((resolve) => stubServer.close(resolve));
  if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
});

test("untrusted consent cannot execute pending actions; admin approval is private and single-use", async () => {
  const directSend = await fetch("http://127.0.0.1:3000/api/whatsapp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "+15551234567", text: "approval test", confirmed: true }),
  });
  expect(directSend.status).toBe(202);
  const directBody = await directSend.json();
  expect(directBody.ok).toBeTruthy();
  expect(directBody.status).toBe("awaiting_confirmation");
  expect(directBody.confirmation.action).toBe("whatsapp_send");
  expect(directBody.task.metadata.args).toBeUndefined();
  expect(JSON.stringify(directBody.task)).not.toContain("approval test");

  const taskListResponse = await fetch("http://127.0.0.1:3000/api/tasks");
  expect(taskListResponse.status).toBe(200);
  const taskList = await taskListResponse.json();
  const listedWhatsAppTask = taskList.find((task) => task.taskId === directBody.task.taskId);
  expect(listedWhatsAppTask.metadata.args).toBeUndefined();
  expect(JSON.stringify(listedWhatsAppTask)).not.toContain("approval test");

  const authorizedApprovalList = await fetch("http://127.0.0.1:3000/api/confirm/list", {
    headers: { "X-Admin-Token": "test-only-admin-token" },
  });
  expect(authorizedApprovalList.status).toBe(200);
  const approvalListBody = await authorizedApprovalList.json();
  const listedWhatsAppApproval = approvalListBody.confirmations.find((item) => item.id === directBody.confirmation.id);
  expect(listedWhatsAppApproval.args.phone).toBe("15551234567");
  expect(listedWhatsAppApproval.args.message).toBe("approval test");

  const unauthenticatedSendApproval = await fetch("http://127.0.0.1:3000/api/confirm/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: directBody.confirmation.id, approved: true }),
  });
  expect(unauthenticatedSendApproval.status).toBe(401);

  const voice = await fetch("http://127.0.0.1:3000/api/voice/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "Send WhatsApp to +15551234567 saying hello", confirmed: true }),
  });
  expect(voice.status).toBe(202);
  const voiceBody = await voice.json();
  expect(voiceBody.ok).toBeTruthy();
  expect(voiceBody.status).toBe("awaiting_confirmation");
  expect(voiceBody.confirmation.action).toBe("saraVoiceExecuteCommand");

  const tasksAfterVoice = await fetch("http://127.0.0.1:3000/api/tasks");
  expect(tasksAfterVoice.status).toBe(200);
  const taskListAfterVoice = await tasksAfterVoice.json();
  const listedVoiceTask = taskListAfterVoice.find((task) => task.taskId === voiceBody.task.taskId);
  expect(listedVoiceTask.metadata.args).toBeUndefined();
  expect(JSON.stringify(listedVoiceTask)).not.toContain("Send WhatsApp to +15551234567");

  const authenticatedPendingList = await fetch("http://127.0.0.1:3000/api/confirm/list", {
    headers: { "X-Admin-Token": "test-only-admin-token" },
  });
  const authenticatedPendingBody = await authenticatedPendingList.json();
  const listedVoiceApproval = authenticatedPendingBody.confirmations.find((item) => item.id === voiceBody.confirmation.id);
  expect(listedVoiceApproval.args.command).toBe("Send WhatsApp to +15551234567 saying hello");

  const unauthenticatedVoiceApproval = await fetch("http://127.0.0.1:3000/api/confirm/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: voiceBody.confirmation.id, approved: true }),
  });
  expect(unauthenticatedVoiceApproval.status).toBe(401);

  const authenticatedVoiceApproval = await fetch("http://127.0.0.1:3000/api/confirm/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": "test-only-admin-token",
    },
    body: JSON.stringify({ id: voiceBody.confirmation.id, approved: true }),
  });
  expect(authenticatedVoiceApproval.status).toBe(200);
  const approvalBody = await authenticatedVoiceApproval.json();
  expect(approvalBody.ok).toBeTruthy();
  expect(approvalBody.approved).toBe(true);
  expect(approvalBody.execResult.ok).toBe(true);

  const replayedApproval = await fetch("http://127.0.0.1:3000/api/confirm/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": "test-only-admin-token",
    },
    body: JSON.stringify({ id: voiceBody.confirmation.id, approved: true }),
  });
  expect(replayedApproval.status).toBe(404);

  const toolCallLog = readFileSync(join(testDataDir, "tool_calls.json"), "utf8");
  expect(toolCallLog).not.toContain("approval test");
  expect(toolCallLog).not.toContain("Send WhatsApp to +15551234567 saying hello");
});
