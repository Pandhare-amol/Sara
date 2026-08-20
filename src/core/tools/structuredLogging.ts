/**
 * Structured logging for Phase 3 tool execution lifecycle.
 * Tracks: execution start, execution complete, verification start, verification complete, final result.
 */

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../../../server_paths";

export enum ToolEventType {
  TOOL_STARTED = "TOOL_STARTED",
  TOOL_EXECUTING = "TOOL_EXECUTING",
  TOOL_EXECUTED = "TOOL_EXECUTED",
  TOOL_VERIFYING = "TOOL_VERIFYING",
  TOOL_VERIFIED = "TOOL_VERIFIED",
  TOOL_FAILED = "TOOL_FAILED",
  TOOL_COMPLETED = "TOOL_COMPLETED",
}

export enum ErrorClassification {
  DESKTOP_AGENT_UNAVAILABLE = "DESKTOP_AGENT_UNAVAILABLE",
  TOOL_NOT_FOUND = "TOOL_NOT_FOUND",
  TOOL_TIMEOUT = "TOOL_TIMEOUT",
  EXECUTION_FAILED = "EXECUTION_FAILED",
  VERIFICATION_FAILED = "VERIFICATION_FAILED",
  WINDOW_NOT_FOUND = "WINDOW_NOT_FOUND",
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  YOUTUBE_NOT_FOUND = "YOUTUBE_NOT_FOUND",
  PLAYBACK_NOT_STARTED = "PLAYBACK_NOT_STARTED",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export interface ToolEvent {
  timestamp: string;
  correlationId: string;
  toolCallId: string;
  eventType: ToolEventType;
  tool: string;
  phase: "execution" | "verification" | "final";
  status?: "success" | "failed" | "uncertain" | "verified" | "partial" | "timeout";
  durationMs?: number;
  errorClassification?: ErrorClassification;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

const TOOL_EVENTS_LOG = path.join(DATA_DIR, "logs", "tool-events.jsonl");

function ensureLogsDir(): void {
  try {
    fs.mkdirSync(path.dirname(TOOL_EVENTS_LOG), { recursive: true });
  } catch {
    /* already exists */
  }
}

/**
 * Log a structured tool event.
 * Events are appended to tool-events.jsonl (JSON Lines format).
 */
export function logToolEvent(event: ToolEvent): void {
  try {
    ensureLogsDir();
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(TOOL_EVENTS_LOG, line);
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Helper to log tool started event.
 */
export function logToolStarted(
  correlationId: string,
  toolCallId: string,
  tool: string,
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_STARTED,
    tool,
    phase: "execution",
  });
}

/**
 * Helper to log tool executing event.
 */
export function logToolExecuting(
  correlationId: string,
  toolCallId: string,
  tool: string,
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_EXECUTING,
    tool,
    phase: "execution",
  });
}

/**
 * Helper to log tool executed event.
 */
export function logToolExecuted(
  correlationId: string,
  toolCallId: string,
  tool: string,
  status: "success" | "failed",
  durationMs: number,
  error?: { classification: ErrorClassification; message: string },
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_EXECUTED,
    tool,
    phase: "execution",
    status,
    durationMs,
    errorClassification: error?.classification,
    errorMessage: error?.message,
  });
}

/**
 * Helper to log tool verifying event.
 */
export function logToolVerifying(
  correlationId: string,
  toolCallId: string,
  tool: string,
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_VERIFYING,
    tool,
    phase: "verification",
  });
}

/**
 * Helper to log tool verified event.
 */
export function logToolVerified(
  correlationId: string,
  toolCallId: string,
  tool: string,
  status: string,
  durationMs: number,
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_VERIFIED,
    tool,
    phase: "verification",
    status: status as any,
    durationMs,
  });
}

/**
 * Helper to log tool completed event.
 */
export function logToolCompleted(
  correlationId: string,
  toolCallId: string,
  tool: string,
  status: string,
  totalDurationMs: number,
): void {
  logToolEvent({
    timestamp: new Date().toISOString(),
    correlationId,
    toolCallId,
    eventType: ToolEventType.TOOL_COMPLETED,
    tool,
    phase: "final",
    status: status as any,
    durationMs: totalDurationMs,
  });
}

/**
 * Read recent tool events from the log file.
 */
export function getRecentToolEvents(limitLines: number = 100): ToolEvent[] {
  try {
    if (!fs.existsSync(TOOL_EVENTS_LOG)) {
      return [];
    }
    const content = fs.readFileSync(TOOL_EVENTS_LOG, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    return lines
      .slice(Math.max(0, lines.length - limitLines))
      .map((line) => {
        try {
          return JSON.parse(line) as ToolEvent;
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null) as ToolEvent[];
  } catch {
    return [];
  }
}

/**
 * Get events for a specific correlation ID.
 */
export function getEventsForCorrelation(correlationId: string): ToolEvent[] {
  return getRecentToolEvents(1000).filter(
    (e) => e.correlationId === correlationId,
  );
}
