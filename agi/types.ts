export type AgiProviderName = "openai" | "anthropic" | "local" | "custom";
export type AgiFeature = "suggestions" | "autocomplete" | "pattern_detection" | "prediction" | "sentiment" | "intent" | "entities";

export interface AgiMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp?: number;
  tags?: string[];
}

export interface AgiContextItem {
  id: string;
  sessionId: string;
  userId?: string;
  content: string;
  tags: string[];
  category: string;
  embedding?: number[];
  createdAt: number;
  updatedAt: number;
}

export interface AgiGenerationRequest {
  input: string;
  messages?: AgiMessage[];
  sessionId: string;
  userId?: string;
  maxTokens?: number;
  temperature?: number;
  tags?: string[];
}

export interface AgiGenerationResult {
  text: string;
  provider: AgiProviderName;
  cached: boolean;
  latencyMs: number;
  requestId: string;
}

export interface AgiProvider {
  readonly name: AgiProviderName;
  generate(request: AgiGenerationRequest, systemPrompt: string): Promise<string>;
}

export interface AgiConfig {
  enabled: boolean;
  provider: AgiProviderName;
  model?: string;
  contextWindow: number;
  maxContextItems: number;
  cacheTtlMs: number;
  retryCount: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  features: Record<AgiFeature, boolean>;
  storage: "indexeddb" | "memory";
  storageName: string;
}

export interface AgiAnalyticsEvent {
  type: "generation" | "error" | "feature" | "context";
  name: string;
  timestamp: number;
  durationMs?: number;
  success?: boolean;
  provider?: AgiProviderName;
  metadata?: Record<string, unknown>;
}

export interface AgiInsight {
  sentiment?: "positive" | "neutral" | "negative";
  intent?: string;
  entities: string[];
  suggestions: string[];
  patterns: string[];
}
