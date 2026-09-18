import type { RoutedToolResult } from "../tools/toolRouter";
import { ToolRouter } from "../tools/toolRouter";

export type IsolationDecision = "ALLOW" | "ASK_USER" | "DENY";

export interface IsolationStep {
  tool: string;
  args: Record<string, unknown>;
  purpose?: string;
  requiresVerification?: boolean;
}

export interface IsolationContext {
  confirmed?: boolean;
  sandboxed?: boolean;
  source?: "user" | "model" | "recovery";
  maxSteps?: number;
}

export interface CouncilReview {
  decision: IsolationDecision;
  reasons: string[];
  reviewedSteps: number;
  strategist: "plan";
  critic: "deterministic-policy-critic";
}

export interface IsolationExecutionResult {
  ok: boolean;
  review: CouncilReview;
  results: Array<{ step: IsolationStep; result: RoutedToolResult }>;
  stoppedAt?: number;
}

const UNTRUSTED_CODE_TOOLS = new Set([
  "runPythonScript",
  "createPythonFile",
  "writeCodeFile",
]);

const DIRECT_EXECUTION_NAMES = /^(?:shell|exec|eval|powershell|cmd|bash)$/i;

/**
 * Guard for graph/council execution. It never executes tools directly: the
 * existing ToolRouter remains the only dispatch boundary.
 */
export class IsolationRuntime {
  constructor(private readonly router: ToolRouter) {}

  review(plan: IsolationStep[], context: IsolationContext = {}): CouncilReview {
    const reasons: string[] = [];
    const maxSteps = Math.max(1, Math.min(context.maxSteps ?? 12, 50));

    if (plan.length === 0) reasons.push("The strategist produced an empty plan.");
    if (plan.length > maxSteps) reasons.push(`Plan exceeds the isolation limit of ${maxSteps} steps.`);

    for (const step of plan.slice(0, maxSteps)) {
      if (DIRECT_EXECUTION_NAMES.test(step.tool)) {
        reasons.push(`Direct interpreter tool '${step.tool}' is not allowed through the isolation runtime.`);
      }
      if (!this.router.registry.has(step.tool)) {
        reasons.push(`Tool '${step.tool}' is not registered in the existing ToolRouter.`);
      }
      if (UNTRUSTED_CODE_TOOLS.has(step.tool) && (!context.sandboxed || context.confirmed !== true)) {
        reasons.push(`Code tool '${step.tool}' requires an isolated sandbox and explicit confirmation.`);
      }
      const metadata = this.router.registry.getMetadata(step.tool);
      if (metadata?.riskLevel === "DESTRUCTIVE_SYSTEM" && context.confirmed !== true) {
        reasons.push(`Destructive tool '${step.tool}' requires explicit confirmation.`);
      }
    }

    const hasConfirmationRequirement = reasons.some((reason) => reason.includes("requires explicit confirmation") || reason.includes("requires an isolated sandbox"));
    return {
      decision: reasons.length === 0 ? "ALLOW" : hasConfirmationRequirement ? "ASK_USER" : "DENY",
      reasons,
      reviewedSteps: Math.min(plan.length, maxSteps),
      strategist: "plan",
      critic: "deterministic-policy-critic",
    };
  }

  async execute(plan: IsolationStep[], context: IsolationContext = {}): Promise<IsolationExecutionResult> {
    const review = this.review(plan, context);
    if (review.decision !== "ALLOW") {
      return { ok: false, review, results: [] };
    }

    const results: Array<{ step: IsolationStep; result: RoutedToolResult }> = [];
    for (const [index, step] of plan.entries()) {
      const result = await this.router.execute(step.tool, {
        ...step.args,
        isolation_reviewed: true,
        isolation_step: index,
      });
      results.push({ step, result });
      if (!result.ok || (step.requiresVerification && result.canonical?.verification_status !== "VERIFIED")) {
        return { ok: false, review, results, stoppedAt: index };
      }
    }
    return { ok: true, review, results };
  }
}