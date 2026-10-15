export interface PollableSecurityAlert {
  id?: string;
  createdAt?: number;
  message?: string;
  [key: string]: unknown;
}

export class SecurityAlertPollingCursor {
  private timestamp: number;
  private readonly seen = new Set<string>();

  constructor(now = Date.now(), lookbackMs = 60_000) {
    this.timestamp = Math.max(0, now - Math.max(0, lookbackMs));
  }

  since(): number {
    return this.timestamp;
  }

  consume(alerts: unknown): PollableSecurityAlert | null {
    if (!Array.isArray(alerts)) return null;
    const unseen: PollableSecurityAlert[] = [];
    for (const value of alerts) {
      if (!value || typeof value !== "object") continue;
      const alert = value as PollableSecurityAlert;
      const createdAt = Number(alert.createdAt);
      const key = typeof alert.id === "string" && alert.id
        ? alert.id
        : `${Number.isFinite(createdAt) ? createdAt : 0}:${String(alert.message || "")}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      unseen.push(alert);
    }
    if (!unseen.length) return null;
    unseen.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0));
    this.timestamp = Math.max(this.timestamp, ...unseen.map((alert) => Number(alert.createdAt) || 0));
    if (this.seen.size > 500) {
      const retained = Array.from(this.seen).slice(-250);
      this.seen.clear();
      for (const id of retained) this.seen.add(id);
    }
    return unseen[unseen.length - 1];
  }
}
