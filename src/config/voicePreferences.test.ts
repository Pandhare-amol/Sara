import test from "node:test";
import assert from "node:assert/strict";
import { resolveVoicePreferences } from "./voicePreferences";
import { SARA_VOICE_PROFILE } from "./saraProfile";

test("voice preference selects a supported male or female speech voice", () => {
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "female" }).voiceName, "Despina");
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "male" }).voiceName, "Puck");
  assert.equal(resolveVoicePreferences({ assistantVoiceGender: "unknown" }).voiceName, "Despina");
});

test("SARA's adult persona age is fictional and remains within the requested range", () => {
  assert.equal(SARA_VOICE_PROFILE.gender_style, "female");
  assert.equal(SARA_VOICE_PROFILE.fictional_persona_age, 20);
  assert.equal(SARA_VOICE_PROFILE.age_style, "fictional_adult_persona");
});

test("relationship styles adjust delivery without claiming a real family relationship", () => {
  const parentStyle = resolveVoicePreferences({ relationshipStyle: "parent" });
  assert.match(parentStyle.instruction, /do not claim to be the user's parent/i);
  assert.equal(resolveVoicePreferences({ relationshipStyle: "teacher" }).relationshipStyle, "teacher");
  assert.equal(resolveVoicePreferences({ relationshipStyle: "untrusted" }).relationshipStyle, "friend");
});
