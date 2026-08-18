/**
 * Anomaly Detection System
 * 
 * Monitors task execution for unusual patterns and deviations:
 * - Detects unusual execution paths
 * - Identifies performance anomalies
 * - Tracks behavioral drift
 * - Alerts on suspicious patterns
 * - Learning-based adaptation
 * 
 * Benefits:
 * - Early detection of system failures
 * - Identification of misconfigurations
 * - Detection of adversarial patterns
 * - Continuous system health monitoring
 * - Automatic trigger for re-training
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface ExecutionMetrics {
  taskId: string;
  tool: string;
  duration: number;              // ms
  success: boolean;
  errorRate: number;             // 0-1
  resourceUsage: {
    cpu?: number;                 // 0-1
    memory?: number;              // bytes
    network?: number;             // bytes
  };
  timestamp: number;
}

export interface AnomalyEvent {
  id: string;
  type:
    | 'performance_degradation'
    | 'unusual_pattern'
    | 'failure_spike'
    | 'resource_spike'
    | 'behavioral_drift';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  metrics: ExecutionMetrics;
  baseline: Record<string, number>;  // Expected values
  deviation: number;                 // 0-1, how far from baseline
  confidence: number;                // 0-1, anomaly confidence
  timestamp: number;
  resolved?: boolean;
}

export interface AnomalyPattern {
  id: string;
  name: string;
  description: string;
  detectionRule: (metrics: ExecutionMetrics) => boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  occurrences: number;
  lastDetected: number;
}

export interface HealthReport {
  timestamp: number;
  overallHealth: number;           // 0-1
  anomalyCount: number;
  criticalAnomalies: number;
  recentAnomalies: AnomalyEvent[];
  systemStatus: 'healthy' | 'degraded' | 'critical';
  recommendations: string[];
}

/**
 * Detects anomalies in task execution patterns
 */
export class AnomalyDetector {
  private metrics: ExecutionMetrics[] = [];
  private anomalies: AnomalyEvent[] = [];
  private patterns: Map<string, AnomalyPattern> = new Map();
  private baselines: Map<string, Record<string, number>> = new Map();
  private dataPath: string;
  private windowSize: number = 100; // Look at last N executions for baseline
  private anomalyThreshold: number = 0.6; // Confidence threshold for flagging anomaly

  constructor(dataPath: string = './data') {
    this.dataPath = dataPath;
    this.loadAnomalyData();
    this.initializeDefaultPatterns();
  }

  /**
   * Record task execution metrics
   */
  recordExecution(metrics: ExecutionMetrics): void {
    this.metrics.push(metrics);

    // Keep only recent metrics
    if (this.metrics.length > this.windowSize * 2) {
      this.metrics = this.metrics.slice(-this.windowSize * 2);
    }

    // Check for anomalies
    this.detectAnomalies(metrics);
  }

  /**
   * Detect anomalies in current execution
   */
  private detectAnomalies(metrics: ExecutionMetrics): void {
    // Get baseline for this tool
    const baseline = this.getBaselineForTool(metrics.tool);

    // Check performance anomalies
    if (metrics.duration > baseline.avgDuration * 3) {
      this.recordAnomaly({
        type: 'performance_degradation',
        severity: 'medium',
        description: `Task "${metrics.tool}" took ${(metrics.duration / 1000).toFixed(1)}s (expected ~${(baseline.avgDuration / 1000).toFixed(1)}s)`,
        metrics,
        baseline,
      });
    }

    // Check failure spike
    if (!metrics.success && baseline.successRate > 0.9) {
      this.recordAnomaly({
        type: 'failure_spike',
        severity: 'high',
        description: `Task "${metrics.tool}" failed unexpectedly (usual success rate: ${(baseline.successRate * 100).toFixed(0)}%)`,
        metrics,
        baseline,
      });
    }

    // Check resource usage anomalies
    if (
      metrics.resourceUsage.cpu &&
      metrics.resourceUsage.cpu > (baseline.avgCpu || 0.5) + 0.3
    ) {
      this.recordAnomaly({
        type: 'resource_spike',
        severity: 'low',
        description: `High CPU usage: ${(metrics.resourceUsage.cpu * 100).toFixed(0)}%`,
        metrics,
        baseline,
      });
    }

    // Check custom patterns
    this.patterns.forEach((pattern) => {
      if (pattern.detectionRule(metrics)) {
        this.recordAnomaly({
          type: 'unusual_pattern',
          severity: pattern.severity,
          description: `Pattern detected: ${pattern.name}`,
          metrics,
          baseline,
        });

        pattern.occurrences++;
        pattern.lastDetected = Date.now();
      }
    });

    // Check for behavioral drift
    const driftScore = this.calculateBehavioralDrift(metrics);
    if (driftScore > 0.7) {
      this.recordAnomaly({
        type: 'behavioral_drift',
        severity: 'medium',
        description: `System behavior is deviating from learned patterns (drift score: ${(driftScore * 100).toFixed(0)}%)`,
        metrics,
        baseline,
      });
    }
  }

  /**
   * Get baseline metrics for a specific tool
   */
  private getBaselineForTool(tool: string): Record<string, number> {
    if (this.baselines.has(tool)) {
      return this.baselines.get(tool)!;
    }

    // Calculate from recent metrics
    const recentMetrics = this.metrics
      .filter((m) => m.tool === tool)
      .slice(-this.windowSize);

    if (recentMetrics.length === 0) {
      return {
        avgDuration: 5000,
        successRate: 0.9,
        avgCpu: 0.3,
        avgMemory: 100000000, // 100MB
      };
    }

    const baseline = {
      avgDuration:
        recentMetrics.reduce((sum, m) => sum + m.duration, 0) /
        recentMetrics.length,
      successRate:
        recentMetrics.filter((m) => m.success).length / recentMetrics.length,
      avgCpu:
        recentMetrics.reduce(
          (sum, m) => sum + (m.resourceUsage.cpu || 0),
          0
        ) / recentMetrics.length,
      avgMemory:
        recentMetrics.reduce(
          (sum, m) => sum + (m.resourceUsage.memory || 0),
          0
        ) / recentMetrics.length,
    };

    this.baselines.set(tool, baseline);
    return baseline;
  }

  /**
   * Calculate behavioral drift score
   */
  private calculateBehavioralDrift(
    currentMetrics: ExecutionMetrics
  ): number {
    if (this.metrics.length < 10) return 0;

    // Compare current execution to historical patterns
    const recentMetrics = this.metrics.slice(-20);
    const avgDuration =
      recentMetrics.reduce((sum, m) => sum + m.duration, 0) /
      recentMetrics.length;
    const avgSuccess =
      recentMetrics.filter((m) => m.success).length / recentMetrics.length;

    let drift = 0;

    // Duration drift
    const durationDiff = Math.abs(currentMetrics.duration - avgDuration);
    drift += Math.min(1, durationDiff / avgDuration);

    // Success drift
    if (currentMetrics.success) {
      drift += Math.max(0, (1 - avgSuccess) * 0.5);
    } else {
      drift += Math.max(0, avgSuccess * 0.5);
    }

    return Math.min(1, drift / 2);
  }

  /**
   * Record an anomaly event
   */
  private recordAnomaly(params: {
    type: AnomalyEvent['type'];
    severity: AnomalyEvent['severity'];
    description: string;
    metrics: ExecutionMetrics;
    baseline: Record<string, number>;
  }): void {
    // Calculate deviation score
    const durationDeviation = Math.abs(
      (params.metrics.duration - params.baseline.avgDuration) /
        params.baseline.avgDuration
    );
    const successDeviation = params.metrics.success
      ? 0
      : 1 - params.baseline.successRate;

    const deviation = Math.min(
      1,
      (durationDeviation + successDeviation) / 2
    );

    // Calculate confidence
    let confidence = Math.min(1, deviation);
    if (params.severity === 'critical') confidence *= 1.2;
    if (params.severity === 'high') confidence *= 1.1;

    confidence = Math.min(1, confidence);

    // Only record if above threshold
    if (confidence < this.anomalyThreshold) return;

    const anomaly: AnomalyEvent = {
      id: uuidv4(),
      type: params.type,
      severity: params.severity,
      description: params.description,
      metrics: params.metrics,
      baseline: params.baseline,
      deviation,
      confidence,
      timestamp: Date.now(),
    };

    this.anomalies.push(anomaly);

    // Keep only recent anomalies
    if (this.anomalies.length > 1000) {
      this.anomalies = this.anomalies.slice(-1000);
    }

    this.persistAnomalies();
  }

  /**
   * Get health report
   */
  getHealthReport(): HealthReport {
    const recentAnomalies = this.anomalies
      .filter((a) => Date.now() - a.timestamp < 3600000) // Last hour
      .slice(-10);

    const criticalCount = this.anomalies.filter(
      (a) => a.severity === 'critical' && !a.resolved
    ).length;

    const unresolved = this.anomalies.filter((a) => !a.resolved);
    const criticalRatio =
      unresolved.length > 0
        ? criticalCount / unresolved.length
        : 0;

    // Calculate overall health
    let health = 1;
    health -= criticalRatio * 0.5; // Critical anomalies hurt health most
    health -= (this.anomalies.filter((a) => a.severity === 'high').length / 10) * 0.3;
    health -= (this.anomalies.filter((a) => a.severity === 'medium').length / 20) * 0.15;

    health = Math.max(0, Math.min(1, health));

    // Determine status
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (health < 0.5) status = 'critical';
    else if (health < 0.75) status = 'degraded';

    // Generate recommendations
    const recommendations: string[] = [];
    if (criticalCount > 0) {
      recommendations.push('Critical anomalies detected - immediate investigation required');
    }
    if (this.anomalies.filter((a) => a.type === 'performance_degradation').length > 3) {
      recommendations.push('Performance degradation trend - consider optimization or resource scaling');
    }
    if (
      this.anomalies.filter((a) => a.type === 'failure_spike').length >
      2
    ) {
      recommendations.push('Failure spike detected - review error logs and configurations');
    }
    if (this.anomalies.filter((a) => a.type === 'behavioral_drift').length > 2) {
      recommendations.push('System behavior is drifting - consider retraining cognitive model');
    }

    return {
      timestamp: Date.now(),
      overallHealth: health,
      anomalyCount: this.anomalies.filter((a) => !a.resolved).length,
      criticalAnomalies: criticalCount,
      recentAnomalies,
      systemStatus: status,
      recommendations,
    };
  }

  /**
   * Get anomaly statistics
   */
  getStatistics(): Record<string, unknown> {
    const byType = new Map<AnomalyEvent['type'], number>();
    const bySeverity = new Map<AnomalyEvent['severity'], number>();

    this.anomalies.forEach((a) => {
      byType.set(a.type, (byType.get(a.type) || 0) + 1);
      bySeverity.set(a.severity, (bySeverity.get(a.severity) || 0) + 1);
    });

    return {
      totalAnomalies: this.anomalies.length,
      unresolvedAnomalies: this.anomalies.filter((a) => !a.resolved).length,
      byType: Object.fromEntries(byType),
      bySeverity: Object.fromEntries(bySeverity),
      detectedPatterns: this.patterns.size,
      metricsRecorded: this.metrics.length,
    };
  }

  /**
   * Mark anomaly as resolved
   */
  resolveAnomaly(anomalyId: string): void {
    const anomaly = this.anomalies.find((a) => a.id === anomalyId);
    if (anomaly) {
      anomaly.resolved = true;
      this.persistAnomalies();
    }
  }

  /**
   * Add custom anomaly detection pattern
   */
  addPattern(pattern: Omit<AnomalyPattern, 'occurrences' | 'lastDetected' | 'id'>): void {
    const fullPattern: AnomalyPattern = {
      ...pattern,
      id: uuidv4(),
      occurrences: 0,
      lastDetected: 0,
    };

    this.patterns.set(fullPattern.id, fullPattern);
  }

  private initializeDefaultPatterns(): void {
    // Pattern: Repeated failures
    this.addPattern({
      name: 'Repeated Failures',
      description: 'Same tool fails multiple times in a row',
      detectionRule: (metrics: ExecutionMetrics) => {
        const sameToolMetrics = this.metrics
          .filter((m) => m.tool === metrics.tool)
          .slice(-5);
        return (
          sameToolMetrics.length >= 3 &&
          sameToolMetrics.every((m) => !m.success)
        );
      },
      severity: 'high',
    });

    // Pattern: Timeout escalation
    this.addPattern({
      name: 'Timeout Escalation',
      description: 'Task durations increasing over time',
      detectionRule: (metrics: ExecutionMetrics) => {
        const sameToolMetrics = this.metrics
          .filter((m) => m.tool === metrics.tool)
          .slice(-5);

        if (sameToolMetrics.length < 3) return false;

        let increasing = 0;
        for (let i = 1; i < sameToolMetrics.length; i++) {
          if (
            sameToolMetrics[i].duration >
            sameToolMetrics[i - 1].duration
          ) {
            increasing++;
          }
        }

        return increasing >= sameToolMetrics.length - 2;
      },
      severity: 'medium',
    });

    // Pattern: Resource exhaustion
    this.addPattern({
      name: 'Resource Exhaustion',
      description: 'Memory or CPU continuously increasing',
      detectionRule: (metrics: ExecutionMetrics) => {
        return (
          (metrics.resourceUsage.memory || 0) > 500000000 ||
          (metrics.resourceUsage.cpu || 0) > 0.8
        );
      },
      severity: 'critical',
    });
  }

  private loadAnomalyData(): void {
    try {
      const anomaliesPath = path.join(this.dataPath, 'anomalies.json');
      if (fs.existsSync(anomaliesPath)) {
        const data = JSON.parse(fs.readFileSync(anomaliesPath, 'utf8'));
        if (Array.isArray(data)) {
          this.anomalies = data;
        }
      }
    } catch (err) {
      console.warn('[AnomalyDetector] Could not load anomaly data', err);
    }
  }

  private persistAnomalies(): void {
    const anomaliesPath = path.join(this.dataPath, 'anomalies.json');
    try {
      fs.writeFileSync(
        anomaliesPath,
        JSON.stringify(this.anomalies, null, 2)
      );
    } catch (err) {
      console.error('[AnomalyDetector] Failed to persist anomalies', err);
    }
  }
}

// Singleton instance
let detectorInstance: AnomalyDetector | null = null;

export function getAnomalyDetector(dataPath?: string): AnomalyDetector {
  if (!detectorInstance) {
    detectorInstance = new AnomalyDetector(dataPath);
  }
  return detectorInstance;
}
