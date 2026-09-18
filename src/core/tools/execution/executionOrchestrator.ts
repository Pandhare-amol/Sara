import crypto from "crypto";
import { ToolRouter } from "../toolRouter";
import { VerificationRegistry } from "../verification/verificationRegistry";
import { IsolationRuntime } from "../../isolation/isolationRuntime";
import { evaluateRetryPolicy } from "../retryPolicy";
import { RecoveryPolicyEngine } from "../recoveryPolicy";
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
import { ToolPolicyEngine, type PolicyContext } from "../policyEngine";

export interface ExecutionContextOptions {
  correlationId?: string;
  toolCallId?: string;
  timeout?: number;
  enableVerification?: boolean;
  policy?: PolicyContext;
}

/**
 * Orchestrates tool execution with independent verification.
 * Routes execution through ToolRouter and verifies results with VerificationRegistry.
 */
export class ExecutionOrchestrator {
  private toolRouter: ToolRouter;
  private verificationRegistry: VerificationRegistry;
  private isolationRuntime: IsolationRuntime;
  private defaultTimeout = 30000;
  private enableVerificationByDefault = true;
  private policyEngine = new ToolPolicyEngine();
  private recoveryPolicyEngine = new RecoveryPolicyEngine();

  constructor(toolRouter: ToolRouter, verificationRegistry: VerificationRegistry, isolationRuntime?: IsolationRuntime) {
    this.toolRouter = toolRouter;
    this.verificationRegistry = verificationRegistry;
    this.isolationRuntime = isolationRuntime ?? new IsolationRuntime(toolRouter);
  }

  private getRetryConfig(tool: string): { maxAttempts: number; supportsRetry: boolean; retryableErrors: string[] } {
    const metadata = this.toolRouter.registry.getMetadata(tool);
    const configured = metadata?.retryPolicy ?? { supportsRetry: true, maxAttempts: 2, retryableErrors: ["TIMEOUT", "NETWORK", "UNAVAILABLE", "BROWSER_TIMEOUT"] };
    const supportsRetry = metadata?.supportsRetry ?? configured.supportsRetry ?? true;
    const maxAttempts = Math.max(1, configured.maxAttempts ?? 2);
    const retryableErrors = (configured.retryableErrors ?? ["TIMEOUT", "NETWORK", "UNAVAILABLE", "BROWSER_TIMEOUT"]).map((value) => value.toLowerCase());
    return { maxAttempts, supportsRetry, retryableErrors };
  }

  private isRetryableFailure(
    tool: string,
    error: { message?: string } | undefined,
    canonical: Record<string, unknown> | undefined,
    allowRetry: boolean,
  ): boolean {
    if (!allowRetry) {
      return false;
    }

    const retryDecision = evaluateRetryPolicy(tool, false);
    if (!retryDecision.allowed) {
      return false;
    }

    const retryText = [
      error?.message,
      typeof canonical?.message === "string" ? canonical.message : undefined,
      typeof canonical?.status === "string" ? canonical.status : undefined,
      typeof canonical?.execution_status === "string" ? canonical.execution_status : undefined,
      typeof canonical?.error === "string" ? canonical.error : undefined,
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

    const retryConfig = this.getRetryConfig(tool);
    return retryConfig.retryableErrors.some((value) => retryText.includes(value));
  }

  private async executeWithFallback(
    tool: string,
    args: Record<string, unknown>,
    context: { correlationId: string; toolCallId: string; timeout: number; enableVerification: boolean; },
    fallbackTools: string[] = [],
  ): Promise<UnifiedToolExecutionResult> {
    const fallbackList = Array.from(new Set(fallbackTools.filter((name) => typeof name === "string" && name.length > 0 && name !== tool)));
    let lastResult: UnifiedToolExecutionResult | undefined;

    for (const candidate of [tool, ...fallbackList]) {
      const candidateArgs = candidate === tool ? { ...args } : { ...args, fallback_used: tool, fallback_from: tool };
      delete (candidateArgs as Record<string, unknown>).fallbackTools;
      const candidateResult = await this.executeWithVerification(candidate, candidateArgs, {
        correlationId: context.correlationId,
        toolCallId: context.toolCallId,
        timeout: context.timeout,
        enableVerification: context.enableVerification,
      });

      if (candidateResult.success || candidateResult.status === "uncertain") {
        if (candidate !== tool && candidateResult.success) {
          candidateResult.message = `Fallback succeeded via ${candidate}. ${candidateResult.message}`.trim();
        }
        return candidateResult;
      }

      lastResult = candidateResult;
    }

    return lastResult ?? {
      tool,
      toolCallId: context.toolCallId,
      correlationId: context.correlationId,
      executionStatus: "failed",
      executionDurationMs: 0,
      executionStartedAt: new Date().toISOString(),
      executionCompletedAt: new Date().toISOString(),
      executionResult: { ok: false },
      verificationStatus: "skipped",
      verificationDurationMs: 0,
      status: "failed",
      success: false,
      verified: false,
      totalDurationMs: 0,
      message: "All fallback routes failed.",
      timestamp: Date.now(),
    };
  }

  private applyRecoveryPlan(
    tool: string,
    error: { code?: string; message?: string; retryable?: boolean } | undefined,
    args: Record<string, unknown>,
  ): { fallbackTools?: string[]; retryable: boolean; reason?: string } {
    const plan = this.recoveryPolicyEngine.selectRecoveryPlan(tool, error || {}, {
      tool,
      confirmed: args.confirmed === true || args.user_confirmed === true,
      sandboxed: args.sandboxed === true || args.isolated === true,
      source: typeof args.source === "string" ? args.source as "user" | "model" | "recovery" : "model",
      riskLevel: typeof args.riskLevel === "string" ? args.riskLevel : "READ_ONLY",
    });

    if (!plan) {
      return { retryable: false };
    }

    if (plan.action === "FALLBACK_TOOL") {
      return { fallbackTools: plan.fallbackTools || [], retryable: false, reason: plan.reason };
    }

    if (plan.action === "RETRY") {
      return { retryable: true, reason: plan.reason };
    }

    return { retryable: false, reason: plan.reason };
  }

  /**
   * Execute a tool with full lifecycle: ROUTING → EXECUTING → VERIFYING → RESULT
   */
  async executeWithVerification(
    tool: string,
    args: Record<string, unknown>,
    options: ExecutionContextOptions = {},
  ): Promise<UnifiedToolExecutionResult> {
    const fallbackTools = Array.isArray(args.fallbackTools) ? args.fallbackTools.filter((value): value is string => typeof value === "string") : [];
    const cleanArgs = { ...args };
    delete cleanArgs.fallbackTools;

    const correlationId = options.correlationId || crypto.randomUUID();
    const toolCallId = options.toolCallId || `${tool}-${Date.now()}`;
    const enableVerification = options.enableVerification ?? this.enableVerificationByDefault;
    const timeout = options.timeout ?? this.defaultTimeout;

    if (fallbackTools.length > 0) {
      return this.executeWithFallback(tool, cleanArgs, { correlationId, toolCallId, timeout, enableVerification }, fallbackTools);
    }

    const startTime = Date.now();
    const executionStartedAt = new Date(startTime).toISOString();

    this.toolRouter.ensureToolRegistered(tool);

    const isolationContext = {
      confirmed: (options.policy?.confirmed ?? args.confirmed === true) || args.user_confirmed === true || args.policy_override === true,
      sandboxed: args.sandboxed === true || args.isolated === true || args.containerized === true,
      source: typeof args.source === "string" && ["user", "model", "recovery"].includes(args.source)
        ? (args.source as "user" | "model" | "recovery")
        : "model",
      maxSteps: 12,
    };

    const isolationReview = this.isolationRuntime.review([
      {
        tool,
        args: { ...args },
        purpose: "execution-gate",
        requiresVerification: enableVerification,
      },
    ], isolationContext);

    if (isolationReview.decision !== "ALLOW") {
      const isolationMessage = isolationReview.reasons.join("; ") || "Tool execution is blocked by the isolation runtime.";
      const isolationResult: UnifiedToolExecutionResult = {
        tool,
        toolCallId,
        correlationId,
        executionStatus: "failed",
        executionDurationMs: 0,
        executionStartedAt,
        executionCompletedAt: new Date().toISOString(),
        executionError: {
          code: isolationReview.decision === "ASK_USER" ? "ISOLATION_CONFIRMATION_REQUIRED" : "ISOLATION_DENIED",
          message: isolationMessage,
          retryable: false,
        },
        executionResult: { ok: false, status: isolationReview.decision, policy_decision: isolationReview.decision, message: isolationMessage },
        verificationStatus: "skipped",
        verificationDurationMs: 0,
        verificationChecks: [],
        verificationError: undefined,
        status: "failed",
        success: false,
        verified: false,
        totalDurationMs: Date.now() - startTime,
        message: isolationMessage,
      } as UnifiedToolExecutionResult;
      return isolationResult;
    }

    const policy = this.policyEngine.evaluate(tool, args, this.toolRouter.registry, {
      ...options.policy,
      confirmed: options.policy?.confirmed ?? args.confirmed === true,
      authorized: options.policy?.authorized ?? args.authorized === true,
    });
    if (policy.decision !== "ALLOW") {
      const policyResult: UnifiedToolExecutionResult = {
        tool,
        toolCallId,
        correlationId,
        executionStatus: "failed",
        executionDurationMs: 0,
        executionStartedAt,
        executionCompletedAt: new Date().toISOString(),
        executionError: { code: policy.decision === "ASK_USER" ? "CONFIRMATION_REQUIRED" : "POLICY_DENIED", message: policy.reason, retryable: false },
        executionResult: { ok: false, status: policy.decision, policy_decision: policy.decision, message: policy.reason },
        verificationStatus: "skipped",
        verificationDurationMs: 0,
        verificationChecks: [],
        verificationError: undefined,
        status: "failed",
        success: false,
        verified: false,
        totalDurationMs: Date.now() - startTime,
        message: policy.reason,
      } as UnifiedToolExecutionResult;
      return policyResult;
    }

    logToolStarted(correlationId, toolCallId, tool);

    let executionStatus: ExecutionStatus = "unknown";
    let executionDurationMs = 0;
    let executionResult: unknown;
    let executionError: { code: string; message: string; retryable?: boolean } | undefined;

    // PHASE 1: EXECUTION
    const executionPhaseStart = Date.now();
    logToolExecuting(correlationId, toolCallId, tool);

    const retryConfig = this.getRetryConfig(tool);
    let attempt = 0;
    let routedResult: any;
    let canonical: Record<string, any> | undefined;
    let executionTimeout: ReturnType<typeof setTimeout> | undefined;

    while (attempt < Math.max(1, retryConfig.maxAttempts)) {
      attempt += 1;
      try {
        routedResult = (await Promise.race([
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

        if ((routedResult as any).error === "WAITING_FOR_APPROVAL") {
          const approvalResult: UnifiedToolExecutionResult = {
            tool,
            toolCallId,
            correlationId,
            executionStatus: "unknown",
            executionDurationMs: 0,
            executionStartedAt,
            executionCompletedAt: new Date().toISOString(),
            executionError: { code: "CONFIRMATION_REQUIRED", message: routedResult.result?.message ?? "User confirmation required", retryable: false },
            executionResult: routedResult.result,
            verificationStatus: "skipped",
            verificationDurationMs: 0,
            verificationChecks: [],
            verificationError: undefined,
            status: "uncertain",
            success: false,
            verified: false,
            totalDurationMs: Date.now() - startTime,
            message: routedResult.result?.message ?? "",
            timestamp: Date.now(),
            metadata: {
              toolRouter: true,
              verificationEnabled: enableVerification,
            },
          };
          return approvalResult;
        }

        executionResult = routedResult.canonical || routedResult.result;
        canonical = (routedResult.canonical as Record<string, any>) || {};
        const execStatusRaw = (canonical.execution_status as string | undefined)?.toLowerCase();
        const finalStatusRaw = (canonical.status as string | undefined)?.toLowerCase();

        if (execStatusRaw === "success") {
          executionStatus = "success";
        } else if (execStatusRaw === "failed" || execStatusRaw === "error") {
          executionStatus = "failed";
        } else if (execStatusRaw === "timeout") {
          executionStatus = "timeout";
        } else if (finalStatusRaw === "success" || routedResult.ok === true) {
          executionStatus = "success";
        } else if (finalStatusRaw === "failed") {
          executionStatus = "failed";
        } else {
          executionStatus = "unknown";
        }

        if (routedResult.ok === false || canonical.status === "FAILED" || canonical.ok === false) {
          executionStatus = "failed";
          const executionFailure = {
            code: "TOOL_EXECUTION_FAILED",
            message: routedResult.error || canonical.error?.message || "Tool execution failed",
            retryable: this.isRetryableFailure(tool, { message: routedResult.error || canonical.error?.message }, canonical, retryConfig.supportsRetry),
          };
          const recoveryPlan = this.applyRecoveryPlan(tool, executionFailure, args);
          executionError = {
            ...executionFailure,
            retryable: executionFailure.retryable || recoveryPlan.retryable,
          };

          if (recoveryPlan.fallbackTools && recoveryPlan.fallbackTools.length > 0) {
            const fallbackResult = await this.executeWithFallback(tool, { ...args }, { correlationId, toolCallId, timeout, enableVerification }, recoveryPlan.fallbackTools);
            if (fallbackResult.success) {
              return fallbackResult;
            }
          }
        }

        if (executionStatus === "failed" && executionError?.retryable && attempt < retryConfig.maxAttempts) {
          continue;
        }
        break;
      } catch (error: any) {
        executionStatus = error?.name === "AbortError" ? "timeout" : "failed";
        const executionFailure = {
          code: executionStatus === "timeout" ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED",
          message: error?.message || `Tool execution failed`,
          retryable: executionStatus === "timeout" && retryConfig.supportsRetry,
        };
        const recoveryPlan = this.applyRecoveryPlan(tool, executionFailure, args);
        executionError = {
          ...executionFailure,
          retryable: executionFailure.retryable || recoveryPlan.retryable,
        };

        if (recoveryPlan.fallbackTools && recoveryPlan.fallbackTools.length > 0) {
          const fallbackResult = await this.executeWithFallback(tool, { ...args }, { correlationId, toolCallId, timeout, enableVerification }, recoveryPlan.fallbackTools);
          if (fallbackResult.success) {
            return fallbackResult;
          }
        }

        if (executionError.retryable && attempt < retryConfig.maxAttempts) {
          continue;
        }
        break;
      } finally {
        if (executionTimeout) {
          clearTimeout(executionTimeout);
          executionTimeout = undefined;
        }
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
