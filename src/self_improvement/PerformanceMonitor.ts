// src/self_improvement/PerformanceMonitor.ts

import { performance } from 'node:perf_hooks';
import { EventBus } from '../core/events/EventBus';

export interface RuntimeHealthSnapshot {
  memoryUsageMb: number;
  cpuUsagePercent: number;
  eventLoopLagMs: number;
  warnings: string[];
  capturedAt: string;
}

/**
 * Monitors Node.js performance metrics and emits events via the EventBus.
 * Emits "performanceMetrics" with a compact runtime snapshot used by the
 * self-analysis engine to decide whether SARA should optimize, degrade, or self-heal.
 */
export class PerformanceMonitor {
  private static _instance: PerformanceMonitor | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lagIntervalHandle: NodeJS.Timeout | null = null;
  private latestSnapshot: RuntimeHealthSnapshot | null = null;

  private constructor() {}

  public static get instance(): PerformanceMonitor {
    if (!PerformanceMonitor._instance) {
      PerformanceMonitor._instance = new PerformanceMonitor();
    }
    return PerformanceMonitor._instance;
  }

  public getLatestSnapshot(): RuntimeHealthSnapshot | null {
    return this.latestSnapshot;
  }

  public collectSnapshot(warnings: string[] = []): RuntimeHealthSnapshot {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const memoryUsageMb = Number((memory.heapUsed / (1024 * 1024)).toFixed(1));
    const cpuUsagePercent = Math.min(100, Number(((((cpu.user + cpu.system) / 1000) / Math.max(1, process.uptime())) * 100).toFixed(1)));
    const eventLoopLagMs = this.measureEventLoopLag();

    const snapshot: RuntimeHealthSnapshot = {
      memoryUsageMb,
      cpuUsagePercent: Number.isFinite(cpuUsagePercent) ? cpuUsagePercent : 0,
      eventLoopLagMs: Number.isFinite(eventLoopLagMs) ? eventLoopLagMs : 0,
      warnings,
      capturedAt: new Date().toISOString(),
    };

    this.latestSnapshot = snapshot;
    this.emitMetrics(snapshot);
    return snapshot;
  }

  public start(intervalMs: number = 5000): void {
    if (this.intervalHandle || this.lagIntervalHandle) return;

    this.intervalHandle = setInterval(() => {
      const warnings: string[] = [];
      const memory = process.memoryUsage();
      if (memory.heapUsed > 512 * 1024 * 1024) warnings.push('memory_pressure');
      if (process.uptime() > 60 && memory.heapUsed > 256 * 1024 * 1024) warnings.push('runtime_growth');
      this.collectSnapshot(warnings);
    }, intervalMs);

    this.lagIntervalHandle = setInterval(() => {
      const start = performance.now();
      setImmediate(() => {
        const lag = performance.now() - start;
        const current = this.latestSnapshot ?? this.collectSnapshot();
        const merged: RuntimeHealthSnapshot = {
          ...current,
          eventLoopLagMs: Number(lag.toFixed(2)),
          warnings: current.warnings.includes('event_loop_lag') ? current.warnings : [...current.warnings, 'event_loop_lag'],
          capturedAt: new Date().toISOString(),
        };
        this.latestSnapshot = merged;
        this.emitMetrics(merged);
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.lagIntervalHandle) {
      clearInterval(this.lagIntervalHandle);
      this.lagIntervalHandle = null;
    }
  }

  private measureEventLoopLag(): number {
    const start = performance.now();
    let result = 0;
    const end = setImmediate(() => {
      result = performance.now() - start;
    });
    if (end) {
      // no-op; event loop lag is measured by the timer branch while the runtime is active
    }
    return result;
  }

  private emitMetrics(payload: RuntimeHealthSnapshot) {
    EventBus.instance.emitEvent('performanceMetrics', payload);
  }
}
