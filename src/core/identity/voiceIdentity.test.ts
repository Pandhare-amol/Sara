import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { VoiceEnrollmentService, VoiceProfileRepository, SpeakerIdentificationService, buildVoiceFingerprint } from "./voiceIdentity";
import { buildLiveConnectionQuery } from "../../lib/audio";

test("experimental numeric voice-feature samples persist with private file permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  try {
    const file = path.join(dir, "voice_profiles.json");
    const repo = new VoiceProfileRepository(file);
    const enrollment = new VoiceEnrollmentService(repo);
    const profile = enrollment.enroll({
      userId: "local-user",
      displayName: "Local User",
      fingerprint: buildVoiceFingerprint([0.1, 0.25, 0.4, 0.3, 0.15, 0.08, 0.03, 0.01]),
      sampleCount: 2,
    });

    assert.equal(profile.userId, "local-user");
    assert.equal(profile.sampleCount, 2);
    assert.equal(repo.load().length, 1);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("experimental similarity compares numeric features and is not an authentication result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  try {
    const repo = new VoiceProfileRepository(path.join(dir, "voice_profiles.json"));
    const sample = buildVoiceFingerprint([0.1, 0.25, 0.4, 0.3, 0.15, 0.08, 0.03, 0.01]);
    new VoiceEnrollmentService(repo).enroll({ userId: "local-user", displayName: "Local User", fingerprint: sample, sampleCount: 2 });

    const match = new SpeakerIdentificationService(repo).identify(sample);
    assert.equal(match?.userId, "local-user");
    assert.ok((match?.confidence ?? 0) > 0.99, "score is only a heuristic similarity score");
    assert.throws(() => buildVoiceFingerprint("transcript text is not audio" as any), /numeric audio-feature vector/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different experimental feature vectors can be rejected by a strict threshold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  try {
    const repo = new VoiceProfileRepository(path.join(dir, "voice_profiles.json"));
    const enrollment = new VoiceEnrollmentService(repo);
    enrollment.enroll({
      userId: "local-user",
      displayName: "Local User",
      fingerprint: buildVoiceFingerprint([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
      sampleCount: 2,
    });
    const strict = new SpeakerIdentificationService(repo, { minSamples: 1, minConfidence: 0.98, maxDistance: 0.1, allowUnenrolledFallback: false });
    assert.equal(strict.identify(buildVoiceFingerprint([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2])), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live connection query carries voice preferences without sending a speaker profile by default", () => {
  const query = buildLiveConnectionQuery("conv-123", null, { assistantVoiceGender: "male", relationshipStyle: "teacher" });
  assert.match(query, /conversationId=conv-123/);
  assert.match(query, /voicePreferences=/);
  assert.doesNotMatch(query, /speakerProfile=/);
});
