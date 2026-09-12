import { VerificationRegistry } from "../tools/verification/verificationRegistry";
import { TaskExecution, TaskExecutionStatus, TaskVerificationStatus } from "../tasks/taskContract";

export interface VerificationOutcome {
  status: TaskVerificationStatus;
  details: Record<string, unknown>;
  verified: boolean;
  method?: string;
  checks?: Array<{ name: string; passed: boolean; evidence?: unknown; reason?: string }>;
}

export class VerificationEngine {
  constructor(private readonly registry: VerificationRegistry = new VerificationRegistry()) {}

  async verifyTask(task: TaskExecution, executionResult: unknown): Promise<VerificationOutcome> {
    const result = await this.registry.verifyExecution(task.toolName, task.arguments, executionResult);

    if (!result) {
      return {
        status: TaskVerificationStatus.NOT_REQUIRED,
        details: { tool: task.toolName, reason: "No verifier was registered for this task." },
        verified: false,
        method: "none",
        checks: [{ name: "no_verifier_registered", passed: false, reason: "This tool has no verification strategy configured." }],
      };
    }

    const status: TaskVerificationStatus = result.verified
      ? TaskVerificationStatus.VERIFIED
      : TaskVerificationStatus.FAILED;

    return {
      status,
      verified: result.verified,
      method: result.method,
      checks: result.checks,
      details: {
        tool: task.toolName,
        verificationMethod: result.method,
        observedState: result.observedState || {},
        details: result.details,
        confidence: result.confidence,
      },
    };
  }

  async markVerifying(task: TaskExecution): Promise<TaskExecution> {
    return {
      ...task,
      status: TaskExecutionStatus.VERIFYING,
      verificationStatus: TaskVerificationStatus.UNCERTAIN,
      userVisibleStatus: "Verifying",
    };
  }
}
