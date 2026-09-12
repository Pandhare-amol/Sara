import test from "node:test";
import assert from "node:assert/strict";

import {
  createDesktopConversation,
  normalizeConversation,
} from "../src/lib/desktopConversationStore";

import { shouldApplyConversationResponse } from "../src/components/desktopChatUtils";
import { createConversationRepository } from "../src/lib/conversationRepository";
import { createTask, getConversationTaskContext, getOrCreateConversation } from "../server_state";
import { buildRateLimitFallbackResponse } from "../server_full";
import { ConversationContextManager, createConversationContextSnapshot } from "../src/lib/conversationContextManager";

test("desktop conversation restore keeps the correct conversation and messages", async () => {
  const projectA = createDesktopConversation("Project A");
  projectA.id = "conv-a";
  projectA.summary = "SARA project context";
  projectA.activeContext = { objective: "Build SARA project context" };
  projectA.taskState = { status: "in_progress", currentStep: "draft plan" };
  projectA.messages = [
    { role: "user", text: "I am working on my SARA project.", timestamp: "2026-08-27T00:00:00.000Z" },
    { role: "assistant", text: "Great, let’s continue the SARA work.", timestamp: "2026-08-27T00:00:05.000Z" },
  ];

  const projectB = createDesktopConversation("College assignment");
  projectB.id = "conv-b";
  projectB.summary = "College assignment context";
  projectB.activeContext = { objective: "Finish economics assignment" };
  projectB.messages = [
    { role: "user", text: "Help me with my college assignment.", timestamp: "2026-08-27T00:01:00.000Z" },
    { role: "assistant", text: "I can help with that assignment.", timestamp: "2026-08-27T00:01:10.000Z" },
  ];

  const records = [projectA, projectB];
  const restoredA = normalizeConversation(records.find((item) => item.id === "conv-a"));
  const restoredB = normalizeConversation(records.find((item) => item.id === "conv-b"));

  assert.ok(restoredA);
  assert.ok(restoredB);
  assert.equal(restoredA?.messages[0]?.text, "I am working on my SARA project.");
  assert.equal(restoredB?.messages[0]?.text, "Help me with my college assignment.");
  assert.equal(restoredA?.activeContext?.objective, "Build SARA project context");
  assert.equal(restoredB?.activeContext?.objective, "Finish economics assignment");
});

test("repository compatibility keeps legacy conversation_id values stable", async () => {
  const repo = createConversationRepository({
    baseUrl: "http://localhost:3000",
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/conversations") || url.includes("/api/conversations/search")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const created = await repo.createConversation({
    title: "Legacy conversation",
    conversation_id: "legacy-conversation-123",
    summary: "Saved project context",
    active_context: { objective: "Keep the project moving" },
    task_state: { status: "in_progress" },
  });

  const snapshot = await repo.restoreContextSnapshot(created.conversation_id);
  assert.ok(snapshot);
  assert.equal(snapshot?.objective, "Keep the project moving");
  assert.equal(created.conversation_id, "legacy-conversation-123");
});

test("stale responses are rejected when the active conversation changed", () => {
  assert.equal(shouldApplyConversationResponse("conv-a", "conv-a"), true);
  assert.equal(shouldApplyConversationResponse("conv-a", "conv-b"), false);
  assert.equal(shouldApplyConversationResponse(null, "conv-b"), false);
  assert.equal(shouldApplyConversationResponse("conv-a", null), false);
});

test("reopening a conversation restores live task state for that conversation", async () => {
  const conversation = await getOrCreateConversation("task-recovery-conversation");
  const task = await createTask({
    conversationId: conversation.id,
    description: "Prepare SARA context restoration",
    priority: 7,
    metadata: { currentStep: "review project summary" },
  });

  await createTask({
    conversationId: "other-conversation",
    description: "Separate unrelated task",
    priority: 1,
  });

  const recovery = await getConversationTaskContext(conversation.id);
  assert.ok(recovery);
  assert.equal(recovery?.taskId, task.taskId);
  assert.equal(recovery?.conversationId, conversation.id);
  assert.equal(recovery?.status, "queued");
});

test("rate-limited Gemini responses use a graceful fallback message", () => {
  const response = buildRateLimitFallbackResponse("continue my project context", {
    summary: "Project continuity",
    activeContext: { objective: "Keep the project moving" },
    taskState: { status: "in_progress" },
  });

  assert.match(response, /rate-limited|quota|retry|continue/i);
  assert.match(response, /project/i);
});

test("conversation context manager keeps recent working context and tracks topic switches", () => {
  const manager = new ConversationContextManager({ maxWorkingMessages: 6, tokenBudget: 1500 });
  const snapshot = manager.buildContextSnapshot({
    id: "conv-topic-switch",
    title: "Project planning",
    messages: [
      { id: "m1", conversationId: "conv-topic-switch", role: "user", content: "We need to plan the SARA project milestone.", timestamp: "2026-08-27T00:00:00.000Z" },
      { id: "m2", conversationId: "conv-topic-switch", role: "assistant", content: "I can help with planning and milestones.", timestamp: "2026-08-27T00:00:02.000Z" },
      { id: "m3", conversationId: "conv-topic-switch", role: "user", content: "Let’s switch to the physics assignment and review the chapter summary.", timestamp: "2026-08-27T00:00:05.000Z" },
      { id: "m4", conversationId: "conv-topic-switch", role: "assistant", content: "Absolutely — I’ll focus on the physics assignment.", timestamp: "2026-08-27T00:00:06.000Z" },
      { id: "m5", conversationId: "conv-topic-switch", role: "user", content: "Please summarize the key equations from chapter 3.", timestamp: "2026-08-27T00:00:07.000Z" },
    ],
  });

  assert.ok(snapshot.summary.toLowerCase().includes("physics") || snapshot.topic.toLowerCase().includes("physics"));
  assert.ok(snapshot.workingContext.length >= 2);
  assert.ok(snapshot.recentTopics.includes("physics") || snapshot.activeTask?.toLowerCase().includes("physics"));

  const restored = createConversationContextSnapshot({
    summary: "Keep the project moving.",
    topic: "Project planning",
    activeTask: "Draft the project plan",
    pendingAction: "Review milestones",
    recentTopics: ["Project planning", "Physics assignment"],
    workingContext: [{ role: "user", content: "Continue the plan" }],
  });

  assert.equal(restored.summary, "Keep the project moving.");
  assert.equal(restored.activeTask, "Draft the project plan");
});
