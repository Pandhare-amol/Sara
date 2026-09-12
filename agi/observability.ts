import type { AgiAnalyticsEvent } from "./types";

export interface LogRecord { level: "debug" | "info" | "warn" | "error"; message: string; correlationId: string; timestamp: number; metadata?: Record<string, unknown>; }
export class StructuredLogger {
  private readonly records: LogRecord[] = [];
  constructor(private readonly sink: (record: LogRecord) => void = (record) => console.log(JSON.stringify(record))) {}
  log(level: LogRecord["level"], message: string, correlationId: string, metadata?: Record<string, unknown>): void { const record = { level, message, correlationId, timestamp: Date.now(), metadata }; this.records.push(record); this.sink(record); }
  snapshot(): LogRecord[] { return [...this.records]; }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();
  increment(name: string, value = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + value); }
  observe(name: string, value: number): void { const values = this.timings.get(name) ?? []; values.push(value); if (values.length > 10_000) values.shift(); this.timings.set(name, values); }
  percentile(name: string, percentile: number): number { const values = [...(this.timings.get(name) ?? [])].sort((a, b) => a - b); if (!values.length) return 0; return values[Math.min(values.length - 1, Math.ceil((percentile / 100) * values.length) - 1)]; }
  prometheus(): string { const lines = [...this.counters].map(([name, value]) => `${name} ${value}`); for (const [name] of this.timings) for (const percentile of [50, 95, 99]) lines.push(`${name}{quantile="${percentile / 100}"} ${this.percentile(name, percentile)}`); return `${lines.join("\n")}\n`; }
  snapshot(): { counters: Record<string, number>; latency: Record<string, { p50: number; p95: number; p99: number }> } { const counters = Object.fromEntries(this.counters); const latency = Object.fromEntries([...this.timings].map(([name]) => [name, { p50: this.percentile(name, 50), p95: this.percentile(name, 95), p99: this.percentile(name, 99) }])); return { counters, latency }; }
}

export class ObservabilityBridge {
  constructor(private readonly metrics: MetricsRegistry, private readonly logger: StructuredLogger) {}
  record(event: AgiAnalyticsEvent, correlationId: string): void { this.metrics.increment(`agi_${event.type}_${event.name}`); if (event.durationMs !== undefined) this.metrics.observe(`agi_${event.name}_latency_ms`, event.durationMs); this.logger.log(event.success === false ? "error" : "info", event.name, correlationId, event.metadata); }
  dashboard(): ReturnType<MetricsRegistry["snapshot"]> { return this.metrics.snapshot(); }
}
