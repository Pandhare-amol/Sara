export interface ApiHealthMetrics {
    apiId: string;
    successRate: number;
    averageLatency: number;
    totalRequests: number;
    failures: number;
    lastSuccess?: Date;
    health: 'healthy' | 'degraded' | 'offline';
}

export class ApiHealthMonitor {
    private metrics: Map<string, ApiHealthMetrics> = new Map();

    public recordSuccess(apiId: string, latencyMs: number): void {
        const metric = this.getOrCreateMetric(apiId);
        metric.totalRequests++;
        metric.lastSuccess = new Date();
        
        // Rolling average for latency
        metric.averageLatency = (metric.averageLatency * (metric.totalRequests - 1) + latencyMs) / metric.totalRequests;
        
        this.updateHealthState(metric);
    }

    public recordFailure(apiId: string): void {
        const metric = this.getOrCreateMetric(apiId);
        metric.totalRequests++;
        metric.failures++;
        this.updateHealthState(metric);
    }

    public getMetrics(apiId: string): ApiHealthMetrics | undefined {
        return this.metrics.get(apiId);
    }

    private getOrCreateMetric(apiId: string): ApiHealthMetrics {
        if (!this.metrics.has(apiId)) {
            this.metrics.set(apiId, {
                apiId,
                successRate: 100,
                averageLatency: 0,
                totalRequests: 0,
                failures: 0,
                health: 'healthy'
            });
        }
        return this.metrics.get(apiId)!;
    }

    private updateHealthState(metric: ApiHealthMetrics): void {
        if (metric.totalRequests > 0) {
            metric.successRate = ((metric.totalRequests - metric.failures) / metric.totalRequests) * 100;
        }

        if (metric.successRate >= 90) {
            metric.health = 'healthy';
        } else if (metric.successRate >= 50) {
            metric.health = 'degraded';
        } else {
            metric.health = 'offline';
        }
    }
}

export const apiHealthMonitor = new ApiHealthMonitor();
