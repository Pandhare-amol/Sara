import type { AgiAnalyticsEvent } from "./types";

export class AgiAnalytics {
  private readonly events: AgiAnalyticsEvent[] = [];

  record(event: Omit<AgiAnalyticsEvent, "timestamp">): void {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > 1_000) this.events.shift();
  }

  snapshot(): { events: AgiAnalyticsEvent[]; totals: Record<string, number>; successRate: number } {
    const totals: Record<string, number> = {};
    for (const event of this.events) totals[event.name] = (totals[event.name] ?? 0) + 1;
    const completed = this.events.filter((event) => event.type === "generation" && event.success !== undefined);
    const successful = completed.filter((event) => event.success).length;
    return { events: [...this.events], totals, successRate: completed.length ? successful / completed.length : 1 };
  }
}
