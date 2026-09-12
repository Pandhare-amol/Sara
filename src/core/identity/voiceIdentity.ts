import fs from "fs";
import path from "path";

export interface VoiceIdentityPolicy {
  minSamples: number;
  minConfidence: number;
  maxDistance: number;
  allowUnenrolledFallback: boolean;
}

export const DEFAULT_VOICE_IDENTITY_POLICY: VoiceIdentityPolicy = {
  minSamples: 1,
  minConfidence: 0.82,
  maxDistance: 0.45,
  allowUnenrolledFallback: false,
};

export interface VoiceProfile {
  id: string;
  userId: string;
  displayName: string;
  fingerprint: number[];
  sampleCount: number;
  createdAt: string;
  updatedAt: string;
  confidence: number;
}

export interface SpeakerIdentificationResult {
  userId: string;
  profileId: string;
  confidence: number;
  distance: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeVector(values: number[]): number[] {
  if (values.length === 0) return Array.from({ length: 8 }, () => 0);
  const maxAbs = Math.max(...values.map((v) => Math.abs(v))) || 1;
  return values.map((v) => clamp01(Math.abs(v) / maxAbs));
}

export function buildVoiceFingerprint(sample: number[] | string): number[] {
  const vectorLength = 8;
  if (Array.isArray(sample)) {
    const normalized = normalizeVector(sample);
    const padded = Array.from({ length: vectorLength }, (_, index) => normalized[index] ?? normalized[normalized.length - 1] ?? 0);
    return padded;
  }

  const text = sample.toLowerCase().trim();
  if (!text) return Array.from({ length: vectorLength }, () => 0);

  const chars = Array.from(text);
  const values = chars.map((character) => character.charCodeAt(0) / 255);
  const padded = Array.from({ length: vectorLength }, (_, index) => {
    const value = values[index] ?? values[values.length - 1] ?? 0;
    return clamp01(Number(value.toFixed(4)));
  });

  return padded;
}

export function compareFingerprints(left: number[], right: number[]): { confidence: number; distance: number } {
  const a = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => (left[index] ?? 0) - (right[index] ?? 0));
  const squared = a.reduce((sum, value) => sum + value * value, 0);
  const distance = Math.sqrt(squared) / Math.max(1, Math.sqrt(a.length));
  const confidence = clamp01(1 - Math.min(distance / 0.8, 1));

  return { confidence, distance: Number(distance.toFixed(4)) };
}

export class VoiceProfileRepository {
  private readonly storePath: string;

  constructor(storePath = path.resolve(process.cwd(), "data", "voice_profiles.json")) {
    this.storePath = storePath;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }

  load(): VoiceProfile[] {
    try {
      if (!fs.existsSync(this.storePath)) return [];
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as VoiceProfile[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  save(profiles: VoiceProfile[]): void {
    fs.writeFileSync(this.storePath, JSON.stringify(profiles, null, 2), "utf-8");
  }
}

export class VoiceEnrollmentService {
  constructor(private readonly repository: VoiceProfileRepository = new VoiceProfileRepository()) {}

  enroll(input: { userId: string; displayName: string; fingerprint: number[] | string; sampleCount?: number; confidence?: number }): VoiceProfile {
    const profiles = this.repository.load();
    const timestamp = new Date().toISOString();
    const existing = profiles.find((profile) => profile.userId === input.userId);
    const fingerprint = buildVoiceFingerprint(input.fingerprint);

    if (existing) {
      existing.fingerprint = fingerprint;
      existing.sampleCount = Math.max(existing.sampleCount, input.sampleCount ?? existing.sampleCount + 1);
      existing.updatedAt = timestamp;
      existing.confidence = input.confidence ?? existing.confidence;
      existing.displayName = input.displayName || existing.displayName;
      this.repository.save(profiles);
      return existing;
    }

    const profile: VoiceProfile = {
      id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: input.userId,
      displayName: input.displayName,
      fingerprint,
      sampleCount: input.sampleCount ?? 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      confidence: input.confidence ?? 1,
    };

    profiles.push(profile);
    this.repository.save(profiles);
    return profile;
  }

  getProfileByUserId(userId: string): VoiceProfile | null {
    return this.repository.load().find((profile) => profile.userId === userId) ?? null;
  }
}

export class SpeakerIdentificationService {
  constructor(
    private readonly repository: VoiceProfileRepository = new VoiceProfileRepository(),
    private readonly policy: VoiceIdentityPolicy = DEFAULT_VOICE_IDENTITY_POLICY,
  ) {}

  listProfiles(): VoiceProfile[] {
    return this.repository.load();
  }

  identify(sample: number[] | string): SpeakerIdentificationResult | null {
    const fingerprint = buildVoiceFingerprint(sample);
    const profiles = this.repository.load().filter((profile) => profile.sampleCount >= this.policy.minSamples);

    if (profiles.length === 0) {
      return this.policy.allowUnenrolledFallback ? { userId: "unknown", profileId: "unidentified", confidence: 0, distance: 1 } : null;
    }

    let best: SpeakerIdentificationResult | null = null;
    for (const profile of profiles) {
      const result = compareFingerprints(profile.fingerprint, fingerprint);
      if (result.confidence >= this.policy.minConfidence && result.distance <= this.policy.maxDistance) {
        const candidate: SpeakerIdentificationResult = {
          userId: profile.userId,
          profileId: profile.id,
          confidence: Number(result.confidence.toFixed(4)),
          distance: Number(result.distance.toFixed(4)),
        };
        if (!best || candidate.confidence > best.confidence) {
          best = candidate;
        }
      }
    }

    return best;
  }
}

export class VoiceIdentityService {
  public readonly enrollment: VoiceEnrollmentService;
  public readonly identification: SpeakerIdentificationService;

  constructor(
    repository: VoiceProfileRepository = new VoiceProfileRepository(),
    policy: VoiceIdentityPolicy = DEFAULT_VOICE_IDENTITY_POLICY,
  ) {
    this.enrollment = new VoiceEnrollmentService(repository);
    this.identification = new SpeakerIdentificationService(repository, policy);
  }
}
