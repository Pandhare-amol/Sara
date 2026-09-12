export interface ApiRateLimitPolicy {
    requestsPerMinute?: number;
    requestsPerDay?: number;
}

interface UsageWindow {
    minuteStartedAt: number;
    minuteCount: number;
    dayStartedAt: number;
    dayCount: number;
}

export interface RateLimitDecision {
    allowed: boolean;
    reason: string;
    retryAfterMs?: number;
}

/** Process-local guard that prevents SARA from exceeding configured provider limits. */
export class ApiRateLimitManager {
    private readonly usage = new Map<string, UsageWindow>();

    public check(providerId: string, policy: ApiRateLimitPolicy = {}, now = Date.now()): RateLimitDecision {
        const current = this.getWindow(providerId, now);
        if (policy.requestsPerMinute && current.minuteCount >= policy.requestsPerMinute) {
            return {
                allowed: false,
                reason: `Provider '${providerId}' minute rate limit reached.`,
                retryAfterMs: Math.max(0, current.minuteStartedAt + 60_000 - now),
            };
        }
        if (policy.requestsPerDay && current.dayCount >= policy.requestsPerDay) {
            return {
                allowed: false,
                reason: `Provider '${providerId}' daily rate limit reached.`,
                retryAfterMs: Math.max(0, current.dayStartedAt + 86_400_000 - now),
            };
        }
        return { allowed: true, reason: "Provider rate limit allows the request." };
    }

    public consume(providerId: string, policy: ApiRateLimitPolicy = {}, now = Date.now()): RateLimitDecision {
        const decision = this.check(providerId, policy, now);
        if (!decision.allowed) return decision;
        const current = this.getWindow(providerId, now);
        current.minuteCount += 1;
        current.dayCount += 1;
        return decision;
    }

    public reset(providerId?: string): void {
        if (providerId) this.usage.delete(providerId);
        else this.usage.clear();
    }

    private getWindow(providerId: string, now: number): UsageWindow {
        const existing = this.usage.get(providerId);
        if (existing && now - existing.minuteStartedAt < 60_000 && now - existing.dayStartedAt < 86_400_000) {
            return existing;
        }
        const current: UsageWindow = {
            minuteStartedAt: existing && now - existing.minuteStartedAt < 60_000 ? existing.minuteStartedAt : now,
            minuteCount: existing && now - existing.minuteStartedAt < 60_000 ? existing.minuteCount : 0,
            dayStartedAt: existing && now - existing.dayStartedAt < 86_400_000 ? existing.dayStartedAt : now,
            dayCount: existing && now - existing.dayStartedAt < 86_400_000 ? existing.dayCount : 0,
        };
        this.usage.set(providerId, current);
        return current;
    }
}

export const apiRateLimitManager = new ApiRateLimitManager();
