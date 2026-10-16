import test from "node:test";
import assert from "node:assert/strict";
import { VoiceEnrollmentService, VoiceProfileRepository, SpeakerIdentificationService, buildVoiceFingerprint } from "./voiceIdentity";
import { buildLiveConnectionQuery } from "../../lib/audio";
import {
  deleteLegacyStoredVoiceProfile,
  hasLegacyStoredVoiceProfile,
  LEGACY_VOICE_PROFILE_STORAGE_KEY,
} from "./legacyVoiceProfile";
import type { VoiceProfileStorage } from "./legacyVoiceProfile";

test("experimental numeric voice features remain only in the in-memory repository", () => {
  const repository = new VoiceProfileRepository();
  const enrollment = new VoiceEnrollmentService(repository);
  const profile = enrollment.enroll({
    userId: "local-user",
    displayName: "Local User",
    fingerprint: buildVoiceFingerprint([0.1, 0.25, 0.4, 0.3, 0.15, 0.08, 0.03, 0.01]),
    sampleCount: 2,
  });

  assert.equal(profile.userId, "local-user");
  assert.equal(profile.sampleCount, 2);
  assert.equal(repository.load().length, 1);
  assert.equal(new VoiceProfileRepository().load().length, 0, "a new repository does not restore speaker features from disk");
});

test("experimental similarity compares numeric features and is not an authentication result", () => {
  const repository = new VoiceProfileRepository();
  const sample = buildVoiceFingerprint([0.1, 0.25, 0.4, 0.3, 0.15, 0.08, 0.03, 0.01]);
  new VoiceEnrollmentService(repository).enroll({ userId: "local-user", displayName: "Local User", fingerprint: sample, sampleCount: 2 });

  const match = new SpeakerIdentificationService(repository).identify(sample);
  assert.equal(match?.userId, "local-user");
  assert.ok((match?.confidence ?? 0) > 0.99, "score is only a heuristic similarity score");
  assert.throws(() => buildVoiceFingerprint("transcript text is not audio" as any), /numeric audio-feature vector/i);
});

test("different experimental feature vectors can be rejected by a strict threshold", () => {
  const repository = new VoiceProfileRepository();
  const enrollment = new VoiceEnrollmentService(repository);
  enrollment.enroll({
    userId: "local-user",
    displayName: "Local User",
    fingerprint: buildVoiceFingerprint([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    sampleCount: 2,
  });
  const strict = new SpeakerIdentificationService(repository, { minSamples: 1, minConfidence: 0.98, maxDistance: 0.1, allowUnenrolledFallback: false });
  assert.equal(strict.identify(buildVoiceFingerprint([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2])), null);
});

test("voice feature profiles can be cleared from memory", () => {
  const repository = new VoiceProfileRepository();
  new VoiceEnrollmentService(repository).enroll({
    userId: "local-user",
    displayName: "Local User",
    fingerprint: buildVoiceFingerprint([0.1, 0.2, 0.3, 0.4]),
  });
  assert.equal(repository.remove("local-user"), true);
  assert.equal(repository.load().length, 0);
  repository.clear();
  assert.equal(repository.remove("missing-user"), false);
});

test("legacy browser voice sample is removed only after explicit confirmation", () => {
  const values = new Map<string, string>([[LEGACY_VOICE_PROFILE_STORAGE_KEY, "legacy numeric sample"]]);
  const storage: VoiceProfileStorage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => { values.delete(key); },
  };

  assert.equal(hasLegacyStoredVoiceProfile(storage), true);
  assert.equal(deleteLegacyStoredVoiceProfile(false, storage), false);
  assert.equal(storage.getItem(LEGACY_VOICE_PROFILE_STORAGE_KEY), "legacy numeric sample");
  assert.equal(deleteLegacyStoredVoiceProfile(true, storage), true);
  assert.equal(hasLegacyStoredVoiceProfile(storage), false);
});

test("legacy voice storage access failures fail closed", () => {
  const deniedStorage: VoiceProfileStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    removeItem: () => { throw new Error("storage unavailable"); },
  };

  assert.equal(hasLegacyStoredVoiceProfile(deniedStorage), false);
  assert.equal(deleteLegacyStoredVoiceProfile(true, deniedStorage), false);
});

test("live connection query carries voice preferences without sending a speaker profile by default", () => {
  const query = buildLiveConnectionQuery("conv-123", null, { assistantVoiceGender: "male", relationshipStyle: "teacher" });
  assert.match(query, /conversationId=conv-123/);
  assert.match(query, /voicePreferences=/);
  assert.doesNotMatch(query, /speakerProfile=/);
});
