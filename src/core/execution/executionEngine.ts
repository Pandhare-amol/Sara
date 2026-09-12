import crypto from "crypto";
import { ExecutionOrchestrator } from "../tools/execution/executionOrchestrator";
import { VerificationRegistry } from "../tools/verification/verificationRegistry";
import { TaskExecution, TaskExecutionStatus, TaskVerificationStatus } from "../tasks/taskContract";

export interface ExecutionMetrics {
  tool: string;
  correlationId: string;
  toolCallId: string;
  status: TaskExecutionStatus;
  verificationStatus: TaskVerificationStatus;
  executionDurationMs: number;
  verificationDurationMs: number;
}

export class ExecutionEngine {
  constructor(
    private readonly executionOrchestrator: ExecutionOrchestrator,
  ) {}

  static createDefault(toolRouter: any): ExecutionEngine {
    const verificationRegistry = new VerificationRegistry();
    return new ExecutionEngine(new ExecutionOrchestrator(toolRouter, verificationRegistry));
  }

  private resolveTimeoutMs(toolName: string): number {
    const map: Record<string, number> = {
      openWebsite: 30000,
      searchYouTube: 30000,
      searchWeb: 25000,
      takeScreenshot: 5000,
      desktopBrowserOpen: 30000,
      default: 15000,
    };
    return map[toolName] || map.default;
  }

  async executeTask(task: TaskExecution): Promise<TaskExecution> {
    const startedAt = new Date().toISOString();
    const executionStart = Date.now();
    const taskWithContext: TaskExecution = {
      ...task,
      correlationId: task.correlationId || crypto.randomUUID(),
      toolCallId: task.toolCallId || `${task.toolName}-${Date.now()}`,
      status: TaskExecutionStatus.RUNNING,
      startedAt,
      verificationStatus: TaskVerificationStatus.SKIPPED,
      userVisibleStatus: "Running",
      attempt: Math.max(1, task.attempt),
    };

    const result = await this.executionOrchestrator.executeWithVerification(taskWithContext.toolName, taskWithContext.arguments, {
      correlationId: taskWithContext.correlationId,
      toolCallId: taskWithContext.toolCallId,
      timeout: this.resolveTimeoutMs(taskWithContext.toolName),
      enableVerification: true,
    });

    const executionDurationMs = Date.now() - executionStart;
    const verificationStatus: TaskVerificationStatus = result.verified
      ? TaskVerificationStatus.VERIFIED
      : result.verificationStatus === "failed"
        ? TaskVerificationStatus.FAILED
        : result.verificationStatus === "not_required"
          ? TaskVerificationStatus.NOT_REQUIRED
          : result.verificationStatus === "skipped"
            ? TaskVerificationStatus.SKIPPED
            : TaskVerificationStatus.UNCERTAIN;

    const resolvedStatus = result.success && result.verified
      ? TaskExecutionStatus.COMPLETED
      : result.executionStatus === "timeout"
        ? TaskExecutionStatus.TIMEOUT
        : result.status === "partial" || verificationStatus === "FAILED"
          ? TaskExecutionStatus.FAILED
          : TaskExecutionStatus.FAILED;

    const nextTask: TaskExecution = {
      ...taskWithContext,
      status: resolvedStatus,
      completedAt: new Date().toISOString(),
      verificationStatus,
      verificationResult: {
        ok: result.success,
        verified: result.verified,
        method: result.verificationMethod,
        status: verificationStatus,
        checks: result.verificationChecks || [],
        observedState: result.verificationObservedState || {},
        executionStatus: result.executionStatus,
        totalDurationMs: result.totalDurationMs,
        executionDurationMs,
      },
      error: result.executionError || result.verificationError
        ? {
            code: result.executionError?.code || result.verificationError?.code || "EXECUTION_RESULT",
            message: (result.executionError?.message || result.verificationError?.message || "Task completed without a clear error"),
            retryable: result.executionError?.retryable || result.verificationError?.retryable,
            details: result.executionError?.details || result.verificationError?.details,
          }
        : undefined,
      userVisibleStatus: resolvedStatus === TaskExecutionStatus.COMPLETED ? "Completed" : resolvedStatus === TaskExecutionStatus.TIMEOUT ? "Timed out" : "Failed",
    };

    return nextTask;
  }

  async execute(task: TaskExecution): Promise<ExecutionMetrics> {
    const updated = await this.executeTask(task);
    return {
      tool: updated.toolName,
      correlationId: updated.correlationId,
      toolCallId: updated.toolCallId,
      status: updated.status,
      verificationStatus: updated.verificationStatus,
      executionDurationMs: 0,
      verificationDurationMs: 0,
    };
  }
}
