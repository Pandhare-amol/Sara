import test from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../src/core/context/ContextManager.ts";

test("context manager preserves current request and prioritizes active tasks", () => {
  const context = new ContextManager().build({
    userInput: "Continue the deployment task",
    activeTasks: [{ taskId: "task-1", status: "running", description: "Deploy SARA", checkpoint: { current_step: "build" } }],
    recentMessages: [{ role: "assistant", content: "I am checking the build." }],
    relevantMemories: [{ category: "preference", text: "Prefer concise status updates.", importance: 8 }],
    maxCharacters: 1_000,
  });

  assert.ok(context.text.includes("CURRENT USER REQUEST"));
  assert.ok(context.text.includes("ACTIVE TASK"));
  assert.ok(context.characters <= 1_000);
  assert.equal(context.included.currentInput, true);
  assert.equal(context.included.activeTasks, 1);
});

test("context manager includes explicit user profile context", () => {
  const context = new ContextManager().build({
    userInput: "Help me plan this task",
    userProfile: {
      userId: "amol",
      displayName: "Amol",
      relationship: "owner",
      preferences: { language: "en" },
      communicationStyle: { detail: "concise" },
    },
  });

  assert.ok(context.text.includes("USER PROFILE"));
  assert.ok(context.text.includes("Amol"));
  assert.equal(context.included.userProfile, true);
});

test("context manager drops lower-priority material at the budget boundary", () => {
  const context = new ContextManager().build({
    userInput: "A short request",
    recentMessages: [{ role: "user", content: "x".repeat(5000) }],
    relevantMemories: [{ text: "Old memory".repeat(500) }],
    maxCharacters: 1_000,
  });

  assert.ok(context.characters <= 1_000);
  assert.equal(context.included.currentInput, true);
  assert.equal(context.included.memories, 0);
});
