export type Cohort = "internal" | "beta" | "all";
export interface RolloutConfig { enabled: boolean; percentage: number; cohort: Cohort; variant?: string; }
export interface RolloutIdentity { userId: string; cohort?: Cohort; tenantId?: string; }

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 10_000;
}

export class RolloutManager {
  private readonly flags = new Map<string, RolloutConfig>();
  private readonly tenantFlags = new Map<string, Map<string, boolean>>();
  private errorCount = 0;
  private requestCount = 0;
  private latencyTotal = 0;
  constructor(private readonly errorRateLimit = 0.02, private readonly latencyLimitMs = 500) {}
  setFlag(name: string, config: RolloutConfig): void { if (config.percentage < 0 || config.percentage > 100) throw new Error("Rollout percentage must be between 0 and 100."); this.flags.set(name, { ...config }); }
  setTenantFlag(tenantId: string, name: string, enabled: boolean): void { const flags = this.tenantFlags.get(tenantId) ?? new Map(); flags.set(name, enabled); this.tenantFlags.set(tenantId, flags); }
  enabled(name: string, identity: RolloutIdentity): boolean { const config = this.flags.get(name); if (!config?.enabled) return false; const tenantValue = identity.tenantId ? this.tenantFlags.get(identity.tenantId)?.get(name) : undefined; if (tenantValue !== undefined) return tenantValue; if (config.cohort !== "all" && identity.cohort !== config.cohort) return false; return stableBucket(`${name}:${identity.userId}`) < config.percentage * 100; }
  record(success: boolean, latencyMs: number): void { this.requestCount++; this.latencyTotal += latencyMs; if (!success) this.errorCount++; }
  shouldRollback(): boolean { return this.requestCount > 0 && (this.errorCount / this.requestCount > this.errorRateLimit || this.latencyTotal / this.requestCount > this.latencyLimitMs); }
  rollback(name?: string): void { if (name) { const config = this.flags.get(name); if (config) config.enabled = false; } else for (const config of this.flags.values()) config.enabled = false; }
  snapshot(): { requestCount: number; errorRate: number; averageLatencyMs: number; rollback: boolean } { return { requestCount: this.requestCount, errorRate: this.requestCount ? this.errorCount / this.requestCount : 0, averageLatencyMs: this.requestCount ? this.latencyTotal / this.requestCount : 0, rollback: this.shouldRollback() }; }
}
