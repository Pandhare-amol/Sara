import type { AgiConfig, AgiFeature } from "./types";

const allFeatures: Record<AgiFeature, boolean> = {
  suggestions: true,
  autocomplete: true,
  pattern_detection: true,
  prediction: false,
  sentiment: true,
  intent: true,
  entities: true,
};

export const defaultAgiConfig: AgiConfig = {
  enabled: false,
  provider: "custom",
  contextWindow: 8_000,
  maxContextItems: 50,
  cacheTtlMs: 60_000,
  retryCount: 2,
  retryBaseDelayMs: 250,
  requestTimeoutMs: 20_000,
  features: allFeatures,
  storage: "indexeddb",
  storageName: "sara-agi-context",
};

export function resolveAgiConfig(overrides: Partial<AgiConfig> = {}): AgiConfig {
  const resolved = {
    ...defaultAgiConfig,
    ...overrides,
    features: { ...allFeatures, ...overrides.features },
  };
  if (!Number.isInteger(resolved.contextWindow) || resolved.contextWindow < 256) throw new Error("contextWindow must be an integer of at least 256.");
  if (!Number.isInteger(resolved.maxContextItems) || resolved.maxContextItems < 1) throw new Error("maxContextItems must be a positive integer.");
  if (resolved.cacheTtlMs < 0 || resolved.retryCount < 0 || resolved.retryBaseDelayMs < 0 || resolved.requestTimeoutMs < 1) throw new Error("Cache, retry, and timeout settings must be non-negative, with requestTimeoutMs positive.");
  return resolved;
}
