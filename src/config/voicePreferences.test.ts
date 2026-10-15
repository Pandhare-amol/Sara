import test from "node:test";
import assert from "node:assert/strict";
import { resolveVoicePreferences } from "./voicePreferences";

test("voice preference selects a supported male or female speech voice", () => {
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "female" }).voiceName, "Despina");
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "male" }).voiceName, "Puck");
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "unknown" }).voiceName, "Despina");
});

test("relationship styles adjust delivery without claiming a real family relationship", () => {
  const parentStyle = resolveVoicePreferences({ relationshipStyle: "parent" });
  assert.match(parentStyle.instruction, /do not claim to be the user's parent/i);
  assert.equal(resolveVoicePreferences({ relationshipStyle: "teacher" }).relationshipStyle, "teacher");
  assert.equal(resolveVoicePreferences({ relationshipStyle: "untrusted" }).relationshipStyle, "friend");
});
