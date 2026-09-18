import test from "node:test";
import assert from "node:assert/strict";
import { classifyFeedback, extractExplicitMemory } from "../src/services/OnlineLearningService";

test("online learning extracts explicit user preferences", () => {
  assert.deepEqual(extractExplicitMemory("I prefer concise answers"), {
    category: "preference",
    semanticType: "preference",
    text: "User preference: concise answers",
  });
});

test("online learning extracts explicit goals", () => {
  const memory = extractExplicitMemory("My goal is to finish my college project");
  assert.equal(memory?.category, "goal");
  assert.equal(memory?.semanticType, "goal");
  assert.equal(memory?.text, "User goal: to finish my college project");
});

test("online learning respects no-store requests", () => {
  assert.equal(extractExplicitMemory("Please don't remember my temporary code"), null);
});

test("online learning ignores ordinary conversation", () => {
  assert.equal(extractExplicitMemory("What is the weather today?"), null);
});

test("online learning classifies corrections as negative feedback", () => {
  assert.equal(classifyFeedback("That answer is wrong, use the second option"), "negative");
  assert.equal(classifyFeedback("That worked perfectly"), "positive");
  assert.equal(classifyFeedback("Please explain the steps"), "neutral");
});