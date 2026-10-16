import test from "node:test";
import assert from "node:assert/strict";
import { stripUnscopedSocialMemory, withoutLegacySocialRecall } from "../src/core/automation/socialMemoryBoundary";

test("legacy social-plan results cannot forward unapproved Python memories to Live", () => {
  const response = { ok: true, result: { result: { intent: "conversation", relevant_memories: ["unapproved personal history"],
    nested: { topic: { memory: "private lookup", suggested_prompt: "Remember this story" }, relevant_memory: "old fact" } } } };
  const filtered = stripUnscopedSocialMemory(response) as any;
  assert.equal(filtered.result.result.intent, "conversation");
  assert.deepEqual(filtered.result.result.nested.topic, {});
  assert.doesNotMatch(JSON.stringify(filtered), /unapproved personal history|private lookup|old fact|Remember this story/);
  assert.match(JSON.stringify(response), /unapproved personal history/, "do not mutate the agent result");
});

test("proactive checks override caller-supplied recall flags instead of trusting them", () => {
  const args = withoutLegacySocialRecall({ context: { unfinished_topic: "Paint the shed", relevant_memory: "old unapproved record",
    privacy_level: "PUBLIC", do_not_store: false } });
  assert.deepEqual(args, { context: { unfinished_topic: "Paint the shed", privacy_level: "DO_NOT_STORE", do_not_store: true } });
});
