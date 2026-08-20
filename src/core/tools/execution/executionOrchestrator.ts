import crypto from "crypto";
import { ToolRouter } from "../toolRouter";
import { VerificationRegistry } from "../verification/verificationRegistry";
import {
  determineFinalStatus,
  buildResultMessage,
  type UnifiedToolExecutionResult,
  type ExecutionStatus,
  type VerificationStatus,
} from "./unifiedExecutionResult";
import {
  logToolStarted,
  logToolExecuting,
  logToolExecuted,
  logToolVerifying,
  logToolVerified,
  logToolCompleted,
  ErrorClassification,
} from "../structuredLogging";

export interface ExecutionContextOptions {
  correlationId?: string;
  toolCallId?: string;
  timeout?: number;
  enableVerification?: boolean;
}

/**
 * Orchestrates tool execution with independent verification.
 * Routes execution through ToolRouter and verifies results with VerificationRegistry.
 */
export class ExecutionOrchestrator {
  private toolRouter: ToolRouter;
  private verificationRegistry: VerificationRegistry;
  private defaultTimeout = 30000;
  private enableVerificationByDefault = true;

  constructor(toolRouter: ToolRouter, verificationRegistry: VerificationRegistry) {
    this.toolRouter = toolRouter;
    this.verificationRegistry = verificationRegistry;
  }

  /**
   * Execute a tool with full lifecycle: ROUTING → EXECUTING → VERIFYING → RESULT
   */
  async executeWithVerification(
    tool: string,
    args: Record<string, unknown>,
    options: ExecutionContextOptions = {},
  ): Promise<UnifiedToolExecutionResult> {
    const correlationId = options.correlationId || crypto.randomUUID();
    const toolCallId = options.toolCallId || `${tool}-${Date.now()}`;
    const enableVerification = options.enableVerification ?? this.enableVerificationByDefault;
    const timeout = options.timeout ?? this.defaultTimeout;

    const startTime = Date.now();
    const executionStartedAt = new Date(startTime).toISOString();

  logToolStarted(correlationId, toolCallId, tool);

    let executionStatus: ExecutionStatus = "unknown";
    let executionDurationMs = 0;
    let executionResult: unknown;
    let executionError: { code: string; message: string; retryable?: boolean } | undefined;

    // PHASE 1: EXECUTION
    const executionPhaseStart = Date.now();
    logToolExecuting(correlationId, toolCallId, tool);

    let executionTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const routedResult = (await Promise.race([
        this.toolRouter.execute(tool, {
          ...args,
          correlation_id: correlationId,
          tool_call_id: toolCallId,
        }),
        new Promise((_, reject) =>
          executionTimeout = setTimeout(
            () => reject(new Error(`Tool execution timeout after ${timeout}ms`)),
            timeout,
          ),
        ),
      ])) as any;

      executionResult = routedResult.canonical || routedResult.result;
      const canonical = routedResult.canonical || {};
      executionStatus =
        (canonical.execution_status as ExecutionStatus | undefined)?.toLowerCase() === "success"
          ? "success"
          : (canonical.execution_status as ExecutionStatus | undefined)?.toLowerCase() === "failed"
            ? "failed"
            : "unknown";

      if (routedResult.ok === false || canonical.status === "FAILED") {
        executionStatus = "failed";
        executionError = {
          code: "TOOL_EXECUTION_FAILED",
          message: routedResult.error || canonical.error?.message || "Tool execution failed",
          retryable: true,
        };
      }
    } catch (error: any) {
      executionStatus = error?.name === "AbortError" ? "timeout" : "failed";
      executionError = {
        code: executionStatus === "timeout" ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED",
        message: error?.message || `Tool execution failed`,
        retryable: executionStatus === "timeout",
      };
    } finally {
      if (executionTimeout) {
        clearTimeout(executionTimeout);
      }
    }

    executionDurationMs = Date.now() - executionPhaseStart;
    const executionCompletedAt = new Date(Date.now()).toISOString();
    logToolExecuted(
      correlationId,
      toolCallId,
      tool,
      executionStatus === "success" ? "success" : "failed",
      executionDurationMs,
    );

    // PHASE 2: VERIFICATION
    const verificationPhaseStart = Date.now();
    let verificationStatus: VerificationStatus = "skipped";
    let verificationDurationMs = 0;
    let verificationMethod: string | undefined;
    let verificationChecks: any[] = [];
    let verificationObservedState: Record<string, unknown> | undefined;
    let verificationError: { code: string; message: string } | undefined;

    if (enableVerification && executionStatus === "success") {
        logToolVerifying(correlationId, toolCallId, tool);

      try {
        const verificationResult = await this.verificationRegistry.verifyExecution(
          tool,
          args,
          executionResult,
        );

        if (verificationResult) {
          verificationStatus = verificationResult.verified ? "verified" : "failed";
          verificationMethod = verificationResult.method;
          verificationChecks = verificationResult.checks;
          verificationObservedState = verificationResult.observedState;

          if (!verificationResult.verified) {
            verificationError = {
              code: "VERIFICATION_FAILED",
              message: verificationResult.details,
            };
          }
        } else {
          verificationStatus = "not_required";
        }
      } catch (error: any) {
        verificationStatus = "failed";
        verificationError = {
          code: "VERIFICATION_ERROR",
          message: error?.message || "Verification failed",
        };
      }

      verificationDurationMs = Date.now() - verificationPhaseStart;
    } else if (!enableVerification && executionStatus === "success") {
      verificationStatus = "not_required";
    } else if (executionStatus !== "success") {
      verificationStatus = "skipped";
    }

    // PHASE 3: FINAL RESULT
    const finalStatus = determineFinalStatus(executionStatus, verificationStatus);
    const success = finalStatus === "success";

    const totalDurationMs = Date.now() - startTime;

    const result: UnifiedToolExecutionResult = {
      tool,
      toolCallId,
      correlationId,
      executionStatus,
      executionDurationMs,
      executionStartedAt,
      executionCompletedAt,
      executionError,
      executionResult,
      verificationStatus,
      verificationDurationMs,
      verificationStartedAt: enableVerification ? executionCompletedAt : undefined,
      verificationCompletedAt: enableVerification
        ? new Date(Date.now()).toISOString()
        : undefined,
      verificationMethod,
      verificationChecks,
      verificationObservedState,
      verificationError,
      status: finalStatus,
      success,
      verified: verificationStatus === "verified",
      totalDurationMs,
      message: buildResultMessage({
        tool,
        toolCallId,
        correlationId,
        executionStatus,
        executionDurationMs,
        executionStartedAt,
        executionCompletedAt,
        executionError,
        executionResult,
        verificationStatus,
        verificationDurationMs,
        verificationMethod,
        verificationChecks,
        verificationObservedState,
        verificationError,
        status: finalStatus,
        success,
        verified: verificationStatus === "verified",
        totalDurationMs,
        message: "",
        timestamp: Date.now(),
      }) || "",
      timestamp: Date.now(),
      metadata: {
        toolRouter: true,
        verificationEnabled: enableVerification,
      },

    };

    logToolCompleted(correlationId, toolCallId, tool, finalStatus, totalDurationMs);

    return result;
  }
}
