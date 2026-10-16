import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceResumeContext } from "../src/core/context/voiceResumeContext";

test("voice reconnect uses bounded recent desktop text and voice turns without duplicating the last request", () => {
  const result = buildVoiceResumeContext({
    summary: "A report about SARA AI",
    messages: [
      ...Array.from({ length: 40 }, (_, index) => ({ role: "user", text: `old-${index} ${"x".repeat(1000)}` })),
      { role: "user", text: "In Word, use font size 14 for my report." },
      { role: "assistant", text: "I can check the document and try that." },
      { role: "user", content: "Did you save the report?" },
      { role: "assistant", content: "The save has not been verified yet." },
    ],
  });
  assert.match(result, /A report about SARA AI/);
  assert.match(result, /In Word, use font size 14/);
  assert.match(result, /Did you save the report/);
  assert.match(result, /save has not been verified yet/);
  assert.doesNotMatch(result, /old-0 /);
  assert.doesNotMatch(result, /CURRENT USER REQUEST/);
  assert.ok(result.length <= 10_000);
});
