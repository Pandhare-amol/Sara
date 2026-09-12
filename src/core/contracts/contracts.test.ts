import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserSessionState } from "./browserContract";
import type { ConversationSessionCheckpoint, TaskContextCheckpoint } from "./sessionContract";

const now = new Date().toISOString();

test("browser session contract round-trips through JSON", () => {
  const session: BrowserSessionState = {
    sessionId: "browser-session-1",
    profileName: "sara-browser",
    persistencePartition: "persist:sara-browser",
    status: "READY",
    activeTabId: "tab-1",
    createdAt: now,
    updatedAt: now,
    tabs: [{
      tabId: "tab-1",
      sessionId: "browser-session-1",
      url: "https://example.com",
      title: "Example",
      loadingState: "LOADED",
      navigationState: "COMPLETED",
      rendererState: "DIRECT",
      processState: "RUNNING",
      active: true,
      createdAt: now,
      lastActiveAt: now,
    }],
  };

  assert.deepEqual(JSON.parse(JSON.stringify(session)), session);
});

test("task checkpoint contract preserves resumability metadata", () => {
  const checkpoint: TaskContextCheckpoint = {
    taskId: "task-1",
    correlationId: "corr-1",
    userIntent: "Open MSBTE and find timetable",
    tool: "desktopBrowserOpen",
    arguments: { url: "https://msbte.org.in" },
    status: "RECOVERING",
    currentStep: "NAVIGATION",
    completedSteps: ["TASK_CREATED"],
    pendingSteps: ["FIND_TIMETABLE"],
    failedSteps: [],
    retryCount: 1,
    currentUrl: "https://msbte.org.in",
    lastObservation: { title: "MSBTE" },
    createdAt: now,
    updatedAt: now,
    resumable: true,
    requiresApproval: false,
  } as TaskContextCheckpoint & { currentUrl: string };

  assert.equal(JSON.parse(JSON.stringify(checkpoint)).resumable, true);
  assert.equal(checkpoint.status, "RECOVERING");
});

test("conversation checkpoint records reconnect ownership", () => {
  const checkpoint: ConversationSessionCheckpoint = {
    sessionId: "session-1",
    conversationId: "conversation-1",
    connectionState: "RESTORING_CONTEXT",
    activeTaskId: "task-1",
    browserSessionId: "browser-session-1",
    browserTabId: "tab-1",
    currentUrl: "https://example.com",
    updatedAt: now,
    reconnectAttempts: 2,
  };

  assert.equal(checkpoint.connectionState, "RESTORING_CONTEXT");
  assert.equal(JSON.parse(JSON.stringify(checkpoint)).activeTaskId, "task-1");
});
