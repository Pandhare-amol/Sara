export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, options.attempts); attempt++) {
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      if (attempt + 1 >= Math.max(1, options.attempts)) break;
      const exponential = Math.min(options.maxDelayMs ?? 30_000, options.baseDelayMs * 2 ** attempt);
      const jitter = exponential * Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
      await sleep(Math.max(0, Math.round(exponential - jitter + Math.random() * jitter * 2)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Operation failed"));
}

export type CircuitState = "closed" | "open" | "half-open";
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  constructor(private readonly failureThreshold = 5, private readonly resetTimeoutMs = 30_000) {}
  getState(): CircuitState { if (this.state === "open" && Date.now() - this.openedAt >= this.resetTimeoutMs) this.state = "half-open"; return this.state; }
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.getState() === "open") throw new Error("Circuit is open; provider temporarily unavailable.");
    try { const result = await operation(); this.failures = 0; this.state = "closed"; return result; }
    catch (error) { this.failures++; if (this.failures >= this.failureThreshold) { this.state = "open"; this.openedAt = Date.now(); } throw error; }
  }
  reset(): void { this.failures = 0; this.state = "closed"; this.openedAt = 0; }
}

export class Bulkhead {
  private active = 0;
  constructor(private readonly limit = 10) {}
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) throw new Error("Bulkhead limit reached; request rejected to protect the service.");
    this.active++;
    try { return await operation(); } finally { this.active--; }
  }
  activeCount(): number { return this.active; }
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private updatedAt = Date.now();
  constructor(private readonly capacity = 60, private readonly refillPerSecond = 1) { this.tokens = capacity; }
  allow(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1_000) * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
  remaining(): number { return Math.floor(this.tokens); }
}
