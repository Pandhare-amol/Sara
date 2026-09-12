import test from "node:test";
import assert from "node:assert/strict";
import { ConversationIntentAnalyzer } from "../src/core/conversation/ConversationIntentAnalyzer.ts";

const analyzer = new ConversationIntentAnalyzer();

test("classifies natural emotional statements without diagnosing", () => {
  const signal = analyzer.analyze("I'm tired today");
  assert.equal(signal.intent, "emotional_statement");
  assert.ok(signal.confidence > 0.8);
  assert.deepEqual(signal.cues, ["emotion_language"]);
});

test("classifies commands and urgent questions", () => {
  assert.equal(analyzer.analyze("Open YouTube").intent, "command");
  const question = analyzer.analyze("What happened urgently?");
  assert.equal(question.intent, "question");
  assert.equal(question.urgency, "high");
});

test("classifies frustration as a recoverable signal", () => {
  const signal = analyzer.analyze("The browser is not working");
  assert.equal(signal.intent, "frustration");
  assert.ok(signal.cues.includes("failure_language"));
});