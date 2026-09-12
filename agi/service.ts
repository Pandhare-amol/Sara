import { AgiAnalytics } from "./analytics";
import { resolveAgiConfig } from "./config";
import { ContextManager, InMemoryVectorStore, IndexedDbVectorStore } from "./context";
import { AgiEventBus } from "./events";
import { Bulkhead, CircuitBreaker, retry } from "./resilience";
import type { AgiConfig, AgiGenerationRequest, AgiGenerationResult, AgiInsight, AgiProvider } from "./types";

export class AgiService {
  readonly events = new AgiEventBus();
  readonly analytics = new AgiAnalytics();
  readonly context: ContextManager;
  private enabled: boolean;
  private readonly cache = new Map<string, { expiresAt: number; result: AgiGenerationResult }>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly bulkhead = new Bulkhead(10);

  constructor(private readonly providers: AgiProvider[], config: Partial<AgiConfig> = {}, context?: ContextManager) {
    this.config = resolveAgiConfig(config);
    this.enabled = this.config.enabled;
    this.context = context ?? new ContextManager(this.config.storage === "indexeddb" ? new IndexedDbVectorStore(this.config.storageName) : new InMemoryVectorStore(), this.config.maxContextItems);
  }
  readonly config: AgiConfig;

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.events.emit("agi:enabled", { enabled }); }
  isEnabled(): boolean { return this.enabled; }

  async generate(request: AgiGenerationRequest): Promise<AgiGenerationResult | null> {
    if (!this.enabled) return null;
    const started = Date.now();
    this.events.emit("agi:input", { sessionId: request.sessionId, input: request.input });
    const key = JSON.stringify([this.config.provider, request.input, request.messages]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true, latencyMs: Date.now() - started };
    const ordered = [...this.providers].sort((a, b) => Number(b.name === this.config.provider) - Number(a.name === this.config.provider));
    let lastError: unknown;
    for (const provider of ordered) {
      const breaker = this.breakers.get(provider.name) ?? new CircuitBreaker(5, 30_000);
      this.breakers.set(provider.name, breaker);
      try {
        const text = await this.bulkhead.execute(() => breaker.execute(() => retry(() => provider.generate(request, this.buildPrompt(request)), { attempts: this.config.retryCount + 1, baseDelayMs: this.config.retryBaseDelayMs, jitterRatio: 0.2 })));
        const result = { text, provider: provider.name, cached: false, latencyMs: Date.now() - started, requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
        this.cache.set(key, { expiresAt: Date.now() + this.config.cacheTtlMs, result });
        this.analytics.record({ type: "generation", name: "generate", durationMs: result.latencyMs, success: true, provider: provider.name });
        this.events.emit("agi:response", { sessionId: request.sessionId, text, provider: provider.name });
        return result;
      } catch (error) { lastError = error; }
    }
    const error = lastError instanceof Error ? lastError : new Error("No AGI provider is available");
    this.analytics.record({ type: "error", name: "generate", durationMs: Date.now() - started, success: false, metadata: { message: error.message } });
    this.events.emit("agi:error", { sessionId: request.sessionId, error });
    return null;
  }

  async analyze(input: string, sessionId: string, userId?: string): Promise<AgiInsight> {
    const lower = input.toLowerCase();
    const sentiment = /\b(hate|bad|angry|sad|problem|fail)\b/.test(lower) ? "negative" : /\b(great|love|good|happy|success)\b/.test(lower) ? "positive" : "neutral";
    const intent = /\?$/.test(input) ? "question" : /\b(do|make|create|send|open|find|need)\b/.test(lower) ? "request" : "statement";
    const entities = [...input.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g)].map((match) => match[0]);
    const patterns = this.config.features.pattern_detection ? (await this.context.retrieve(input, userId)).map((item) => item.category) : [];
    const insight: AgiInsight = { sentiment: this.config.features.sentiment ? sentiment : undefined, intent: this.config.features.intent ? intent : undefined, entities: this.config.features.entities ? [...new Set(entities)] : [], suggestions: this.config.features.suggestions && intent === "question" ? ["Review relevant context before answering"] : [], patterns: [...new Set(patterns)] };
    this.events.emit("agi:insight", { sessionId, insight });
    this.analytics.record({ type: "feature", name: "analyze", success: true, metadata: { sessionId } });
    return insight;
  }

  private buildPrompt(request: AgiGenerationRequest): string {
    const context = request.messages?.slice(-10).map((message) => `${message.role}: ${message.content}`).join("\n") ?? "";
    return `You are an optional reasoning enhancement for SARA. Be concise, factual, and explicit about uncertainty.\nContext:\n${this.context.summarize([{ role: "conversation", content: context }], this.config.contextWindow)}\nUser input: ${request.input}`;
  }
}
