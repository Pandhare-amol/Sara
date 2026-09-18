export type SelfImprovementStatus = 'healthy' | 'warning' | 'critical';

export interface HealthSnapshot {
  memoryUsageMb: number;
  cpuUsagePercent: number;
  eventLoopLagMs: number;
  warnings?: string[];
}

export interface SelfImprovementConfig {
  memoryThresholdMb: number;
  cpuThresholdPercent: number;
  eventLoopLagThresholdMs: number;
  healthCheckIntervalMs?: number;
}

export interface SelfImprovementReport {
  status: SelfImprovementStatus;
  recommendations: string[];
  metrics: {
    memoryUsageMb: number;
    cpuUsagePercent: number;
    eventLoopLagMs: number;
  };
}

export class SelfImprovementEngine {
  constructor(private readonly config: SelfImprovementConfig) {}

  public analyze(snapshot: HealthSnapshot): SelfImprovementReport {
    const memoryCritical = snapshot.memoryUsageMb >= this.config.memoryThresholdMb;
    const cpuCritical = snapshot.cpuUsagePercent >= this.config.cpuThresholdPercent;
    const lagCritical = snapshot.eventLoopLagMs >= this.config.eventLoopLagThresholdMs;

    const warnings = snapshot.warnings ?? [];

    let status: SelfImprovementStatus = 'healthy';
    if (memoryCritical || cpuCritical || lagCritical || warnings.length > 0) {
      status = warnings.length > 2 || memoryCritical && cpuCritical || lagCritical && cpuCritical ? 'critical' : 'warning';
    }

    const recommendations: string[] = [];
    if (memoryCritical) {
      recommendations.push('Reduce memory pressure by trimming cache state, closing idle sessions, and batching background work.');
    }
    if (cpuCritical) {
      recommendations.push('Optimize CPU-heavy work by reducing unnecessary polling, lowering capture intervals, and parallelizing safe tasks.');
    }
    if (lagCritical) {
      recommendations.push('Stabilize the event loop by deferring non-critical timers and reducing synchronous file or network blocking.');
    }
    if (warnings.length > 0) {
      recommendations.push(`Review warnings: ${warnings.join(', ')}`);
    }
    if (recommendations.length === 0) {
      recommendations.push('Continue steady-state operation and keep the current runtime configuration.');
    }

    return {
      status,
      recommendations,
      metrics: {
        memoryUsageMb: snapshot.memoryUsageMb,
        cpuUsagePercent: snapshot.cpuUsagePercent,
        eventLoopLagMs: snapshot.eventLoopLagMs,
      },
    };
  }
}
