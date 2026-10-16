import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthoritativeTaskResult, ExecutionState } from "../types/AuthoritativeTaskResult";
import { isTerminalState, isVerifiedTaskSuccess } from "../types/AuthoritativeTaskResult";
import { validateMemoryText } from "../security/memoryContentPolicy";

export type LearningFeedbackRating = "accurate" | "partially_accurate" | "inaccurate";

export interface LearningRecordFeedback {
  rating: LearningFeedbackRating;
  note?: string;
  recordedAt: string;
  consentToLearn: true;
}

export interface LearningRecord {
  schemaVersion: 1;
  id: string;
  kind: "task_outcome";
  source: "authoritative_task_runner";
  taskId: string;
  recordedAt: string;
  state: ExecutionState;
  tools: string[];
  durationMs?: number;
  verification: {
    attempted: boolean;
    passed: boolean;
    method?: string;
    checks: Array<{ name: string; passed: boolean }>;
  };
  verifiedSuccess: boolean;
  feedback?: LearningRecordFeedback;
}

export interface LearningFeedbackInput {
  rating: LearningFeedbackRating;
  note?: string;
  consentToLearn: boolean;
}

const FEEDBACK_RATINGS = new Set<LearningFeedbackRating>([
  "accurate",
  "partially_accurate",
  "inaccurate",
]);
const MAX_FEEDBACK_LENGTH = 1_000;
const MAX_TASK_ID_LENGTH = 200;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;
const SAFE_LABEL = /^[A-Za-z0-9_.:-]+$/;

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 80 && SAFE_LABEL.test(label) ? label : undefined;
}

function safeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const taskId = value.trim();
  return taskId.length > 0 && taskId.length <= MAX_TASK_ID_LENGTH && SAFE_IDENTIFIER.test(taskId)
    ? taskId
    : undefined;
}

function isAuthoritativeTaskResult(value: unknown): value is AuthoritativeTaskResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AuthoritativeTaskResult>;
  return Boolean(
    safeTaskId(result.taskId) &&
    typeof result.state === "string" &&
    isTerminalState(result.state) &&
    typeof result.success === "boolean" &&
    typeof result.verified === "boolean" &&
    typeof result.goal === "string" &&
    Array.isArray(result.actions) &&
    result.verification && typeof result.verification === "object" &&
    typeof result.verification.attempted === "boolean" &&
    typeof result.verification.passed === "boolean" &&
    Array.isArray(result.verification.checks),
  );
}

function safeRecordedAt(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function cloneRecords(records: LearningRecord[]): LearningRecord[] {
  return JSON.parse(JSON.stringify(records)) as LearningRecord[];
}

export class LearningRecordStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxRecords = 1000) {
    this.filePath = path.resolve(filePath);
    this.maxRecords = Math.max(1, Math.floor(maxRecords));
  }

  private async readRecords(): Promise<LearningRecord[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Learning record file is invalid; it was left untouched.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Learning record file has an invalid structure; it was left untouched.");
    }
    return parsed as LearningRecord[];
  }

  private async writeRecords(records: LearningRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(records, null, 2), { encoding: "utf-8", mode: 0o600 });
      try { await chmod(temporaryPath, 0o600); } catch { /* ACLs may differ by platform. */ }
      await rename(temporaryPath, this.filePath);
      try { await chmod(this.filePath, 0o600); } catch { /* best effort on supported platforms. */ }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async listRecords(): Promise<LearningRecord[]> {
    await this.writeQueue;
    return cloneRecords(await this.readRecords());
  }

  /** Record only a minimized view of a terminal authoritative TaskRunner result. */
  async recordTaskOutcome(value: unknown): Promise<LearningRecord | null> {
    if (!isAuthoritativeTaskResult(value)) return null;
    const result = value;
    const taskId = safeTaskId(result.taskId);
    if (!taskId) return null;

    const actionTools = result.actions
      .map((action) => safeLabel(action?.tool))
      .filter((tool): tool is string => Boolean(tool));
    const checks = result.verification.checks
      .slice(0, 30)
      .filter((check) => check && typeof check === "object")
      .map((check) => ({ name: safeLabel(check.name), passed: check.passed === true }))
      .filter((check): check is { name: string; passed: boolean } => Boolean(check.name));
    const duration = Number(result.durationMs);
    const record: LearningRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: "task_outcome",
      source: "authoritative_task_runner",
      taskId,
      recordedAt: safeRecordedAt(result.completedAt),
      state: result.state,
      tools: Array.from(new Set(actionTools)).slice(0, 20),
      ...(Number.isFinite(duration) && duration >= 0 && duration <= 24 * 60 * 60 * 1000 ? { durationMs: duration } : {}),
      verification: {
        attempted: result.verification.attempted === true,
        passed: result.verification.passed === true,
        ...(safeLabel(result.verification.method) ? { method: safeLabel(result.verification.method) } : {}),
        checks,
      },
      verifiedSuccess: isVerifiedTaskSuccess(result),
    };

    return this.runExclusive(async () => {
      const records = await this.readRecords();
      const existing = records.find((entry) => entry.taskId === taskId && entry.kind === "task_outcome");
      if (existing) return cloneRecords([existing])[0];
      if (records.length >= this.maxRecords) {
        throw new Error("Learning record capacity reached. Export or review records before adding more.");
      }
      await this.writeRecords([...records, record]);
      return cloneRecords([record])[0];
    });
  }

  /** Store an explicit user rating only after consent to local learning use. */
  async submitFeedback(taskIdValue: string, input: LearningFeedbackInput): Promise<LearningRecord | null> {
    const taskId = safeTaskId(taskIdValue);
    if (!taskId) throw new Error("A valid task ID is required.");
    if (input?.consentToLearn !== true) throw new Error("Explicit consent is required before storing feedback for learning.");
    if (!FEEDBACK_RATINGS.has(input.rating)) throw new Error("Feedback rating is invalid.");

    let note: string | undefined;
    if (input.note !== undefined && input.note !== "") {
      if (typeof input.note !== "string") throw new Error("Feedback note must be text.");
      const validation = validateMemoryText(input.note, MAX_FEEDBACK_LENGTH);
      if (validation.ok === false) throw new Error(validation.error);
      note = validation.text;
    }

    return this.runExclusive(async () => {
      const records = await this.readRecords();
      const index = records.findIndex((entry) => entry.taskId === taskId && entry.kind === "task_outcome");
      if (index < 0 || records[index].verifiedSuccess !== true) return null;
      const nextFeedback: LearningRecordFeedback = {
        rating: input.rating,
        ...(note ? { note } : {}),
        recordedAt: new Date().toISOString(),
        consentToLearn: true,
      };
      const existingFeedback = records[index].feedback;
      if (existingFeedback) {
        if (existingFeedback.rating === nextFeedback.rating && existingFeedback.note === nextFeedback.note) {
          return cloneRecords([records[index]])[0];
        }
        throw new Error("Feedback for this task has already been recorded and cannot be overwritten.");
      }

      const updated = { ...records[index], feedback: nextFeedback };
      const nextRecords = [...records];
      nextRecords[index] = updated;
      await this.writeRecords(nextRecords);
      return cloneRecords([updated])[0];
    });
  }
}
