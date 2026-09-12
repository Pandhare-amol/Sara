import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { VoiceEnrollmentService, VoiceProfileRepository, SpeakerIdentificationService, buildVoiceFingerprint } from "./voiceIdentity";
import { buildLiveConnectionQuery } from "../../lib/audio";

test("voice enrollment stores a persistent speaker profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  const repo = new VoiceProfileRepository(path.join(dir, "voice_profiles.json"));
  const enrollment = new VoiceEnrollmentService(repo);
  const profile = enrollment.enroll({
    userId: "tech",
    displayName: "TECH",
    fingerprint: buildVoiceFingerprint("hello there, this is the sample."),
    sampleCount: 2,
  });

  assert.equal(profile.userId, "tech");
  assert.equal(profile.sampleCount, 2);
  assert.equal(repo.load().length, 1);
});

test("matching voice samples are attributed to the same speaker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  const repo = new VoiceProfileRepository(path.join(dir, "voice_profiles.json"));
  const enrollment = new VoiceEnrollmentService(repo);
  const sample = buildVoiceFingerprint("Please open the project and read the build log");

  enrollment.enroll({ userId: "tech", displayName: "TECH", fingerprint: sample, sampleCount: 2 });

  const identification = new SpeakerIdentificationService(repo);
  const match = identification.identify(sample);

  assert.ok(match);
  assert.equal(match?.userId, "tech");
  assert.ok((match?.confidence ?? 0) >= 0.82);
});

test("mismatched voice samples are rejected below the identity threshold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-voice-"));
  const repo = new VoiceProfileRepository(path.join(dir, "voice_profiles.json"));
  const enrollment = new VoiceEnrollmentService(repo);

  enrollment.enroll({
    userId: "tech",
    displayName: "TECH",
    fingerprint: buildVoiceFingerprint("This is a sample from the known user"),
    sampleCount: 2,
  });

  const identification = new SpeakerIdentificationService(repo, { minSamples: 1, minConfidence: 0.96, maxDistance: 0.2, allowUnenrolledFallback: false });
  const unknown = identification.identify(buildVoiceFingerprint("Completely different speaker phrase withheld"));

  assert.equal(unknown, null);
});

test("live connection query carries the current speaker context without altering the default route", () => {
  const query = buildLiveConnectionQuery("conv-123", { userId: "tech", displayName: "TECH" });

  assert.equal(query.includes("conversationId=conv-123"), true);
  assert.equal(query.includes("speakerProfile="), true);
  assert.equal(query.includes("TECH"), true);
});
