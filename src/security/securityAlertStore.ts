import crypto from "node:crypto";
import type { Request, Response } from "express";
import { isLoopbackAddress } from "./requestGuards";

export interface SecurityAlertEvent {
  id: string;
  createdAt: number;
  severity: "WARNING";
  message: string;
  attempts: number;
}

export class SecurityAlertStore {
  private readonly events: SecurityAlertEvent[] = [];
  private readonly limit: number;

  constructor(limit = 50) {
    this.limit = Math.max(1, Math.min(500, Math.floor(limit)));
  }

  add(event: Omit<SecurityAlertEvent, "id" | "createdAt"> & Partial<Pick<SecurityAlertEvent, "id" | "createdAt">>): SecurityAlertEvent {
    const safeMessage = String(event.message || "Security warning.").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
    const createdAt = Number(event.createdAt);
    const alert: SecurityAlertEvent = {
      id: typeof event.id === "string" && event.id.length <= 100 ? event.id : crypto.randomUUID(),
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
      severity: "WARNING",
      message: safeMessage,
      attempts: Math.max(0, Math.floor(Number(event.attempts) || 0)),
    };
    this.events.push(alert);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return alert;
  }

  since(timestamp: number): SecurityAlertEvent[] {
    const boundary = Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0;
    return this.events.filter((event) => event.createdAt >= boundary).map((event) => ({ ...event }));
  }

  list(): SecurityAlertEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function handleSecurityAlertsRequest(
  req: Pick<Request, "query" | "socket">,
  res: Pick<Response, "status" | "json">,
  store: SecurityAlertStore,
): unknown {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ ok: false, error: "Security alerts are available only on this computer." });
  }
  const requestedSince = Number(req.query.since || 0);
  const since = Number.isFinite(requestedSince) ? Math.max(0, requestedSince) : 0;
  return res.json({ ok: true, alerts: store.since(since) });
}
