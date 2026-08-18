import fs from "fs";
import path from "path";
import crypto from "crypto";
import { appendAuditEvent as dbAppendAuditEvent, loadRecentAuditEvents as dbLoadRecentAuditEvents } from "../../server_state";
import { sendWebhook } from "./notifications";

export type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export interface AuditEvent {
  event_id: string;
  previous_event_hash?: string;
  event_hash: string;
  timestamp: string;
  session_id?: string;
  task_id?: string;
  agent_id?: string;
  event_type: string;
  status?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  severity?: Severity;
}

export function redactSecrets(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/(api_?key|token|password|secret|auth|bearer|passwd)\s*[:=]\s*["']?[^"'\s,]+["']?/gi, "$1=********");
  }
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const copy: any = {};
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes("key") || lk.includes("token") || lk.includes("password") || lk.includes("secret") || lk.includes("auth")) {
      copy[k] = "********";
    } else {
      copy[k] = redactSecrets(obj[k]);
    }
  }
  return copy;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export class AuditLogger {
  private logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {}
  }

  async append(event: Omit<AuditEvent, "event_id" | "event_hash" | "previous_event_hash" | "timestamp"> & { timestamp?: string }) {
    const cleanMetadata = redactSecrets(event.metadata || {});
    const cleanEvent = { ...event, metadata: cleanMetadata };

    try {
      if (typeof dbAppendAuditEvent === "function") {
        const rec = await dbAppendAuditEvent({ ...cleanEvent, event_type: cleanEvent.event_type, timestamp: cleanEvent.timestamp });
        return rec;
      }
    } catch (e) {
      // fallback to file-based logger
    }

    const now = cleanEvent.timestamp || new Date().toISOString();
    const id = crypto.randomUUID();
    const payload: AuditEvent = {
      event_id: id,
      previous_event_hash: undefined,
      timestamp: now,
      session_id: cleanEvent.session_id,
      task_id: cleanEvent.task_id,
      agent_id: cleanEvent.agent_id,
      event_type: cleanEvent.event_type,
      status: cleanEvent.status,
      duration_ms: cleanEvent.duration_ms,
      metadata: cleanEvent.metadata,
      severity: cleanEvent.severity || "INFO",
      event_hash: "",
    };
    const toHash = JSON.stringify({
      event_id: payload.event_id,
      previous_event_hash: payload.previous_event_hash,
      timestamp: payload.timestamp,
      event_type: payload.event_type,
      metadata: payload.metadata || {},
    });
    payload.event_hash = sha256Hex(toHash);

    const logPath = path.join(this.logDir, "audit.log");
    try {
      fs.appendFileSync(logPath, JSON.stringify(payload) + "\n");
    } catch (e) {}

    try {
      if (payload.severity === "HIGH" || payload.severity === "CRITICAL") {
        const { listWebhooks } = await import("../../server_state");
        const whs = await listWebhooks();
        for (const w of whs) {
          try {
            const events = w.events || [];
            if (events.includes("*") || events.includes(payload.event_type)) {
              sendWebhook(
                w.url,
                { event: payload.event_type, severity: payload.severity, timestamp: payload.timestamp, metadata: payload.metadata },
                w.secret || undefined
              ).catch(() => {});
            }
          } catch {}
        }
      }
    } catch {}

    return payload;
  }

  async readAll(): Promise<AuditEvent[]> {
    try {
      if (typeof dbLoadRecentAuditEvents === "function") {
        return (await dbLoadRecentAuditEvents(1000)) as unknown as AuditEvent[];
      }
    } catch (e) {}
    try {
      const logPath = path.join(this.logDir, "audit.log");
      if (!fs.existsSync(logPath)) return [];
      return fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (e) {
      return [];
    }
  }
}

