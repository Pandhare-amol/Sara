import test from "node:test";
import assert from "node:assert/strict";
import { ConversationIntentAnalyzer } from "../src/core/conversation/ConversationIntentAnalyzer";

test("serious distress produces a private calm policy without humor", () => {
  const analyzer = new ConversationIntentAnalyzer();
  const policy = analyzer.analyzeEmotion("I am overwhelmed and this is not working, please help me right now.");

  assert.equal(policy.signal, "frustrated");
  assert.equal(policy.humorAllowed, false);
  assert.equal(policy.playfulAllowed, false);
  assert.equal(policy.responseMode, "calm_direct");
  assert.ok(policy.confidence > 0.8);
});

test("safety language takes precedence over positive or playful words", () => {
  const analyzer = new ConversationIntentAnalyzer();
  const policy = analyzer.analyzeEmotion("This is dangerous, do not make a joke, I need help urgently.");

  assert.equal(policy.signal, "serious");
  assert.equal(policy.humorAllowed, false);
  assert.equal(policy.playfulAllowed, false);
  assert.equal(policy.reason, "safety_or_emergency_language");
});

test("ordinary positive conversation may retain natural humor", () => {
  const analyzer = new ConversationIntentAnalyzer();
  const policy = analyzer.analyzeEmotion("That is wonderful news, thank you!");

  assert.equal(policy.signal, "positive");
  assert.equal(policy.humorAllowed, true);
  assert.equal(policy.playfulAllowed, true);
});
