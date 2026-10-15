export interface AdminAuthAbuseResult {
  attempts: number;
  warn: boolean;
  shouldLock: boolean;
}

interface AttemptWindow {
  timestamps: number[];
  warned: boolean;
  lockIssued: boolean;
}

/** Tracks repeated bad admin credentials without persisting secret material. */
export class AdminAuthAbuseTracker {
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(
    private readonly warningThreshold = 3,
    private readonly lockThreshold = 5,
    private readonly windowMs = 5 * 60 * 1000,
    private readonly maxSources = 2048,
  ) {}

  get trackedSourceCount(): number {
    return this.attempts.size;
  }

  record(source: string, now = Date.now()): AdminAuthAbuseResult {
    const key = String(source || "unknown").slice(0, 128);
    this.prune(now);
    const window = this.attempts.get(key) || { timestamps: [], warned: false, lockIssued: false };
    window.timestamps.push(now);
    const attempts = window.timestamps.length;
    const warn = attempts >= this.warningThreshold && !window.warned;
    const shouldLock = attempts >= this.lockThreshold && !window.lockIssued;
    if (warn) window.warned = true;
    if (shouldLock) window.lockIssued = true;
    this.attempts.delete(key);
    this.attempts.set(key, window);
    this.evictOldestSources();
    return { attempts, warn, shouldLock };
  }

  clear(source: string): void {
    this.attempts.delete(String(source || "unknown").slice(0, 128));
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, window] of this.attempts) {
      window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff && timestamp <= now);
      if (window.timestamps.length === 0) this.attempts.delete(key);
    }
  }

  private evictOldestSources(): void {
    while (this.attempts.size > Math.max(1, this.maxSources)) {
      const oldestKey = this.attempts.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.attempts.delete(oldestKey);
    }
  }
}
