/**
 * Task Evaluator
 *
 * After-task assessment system that evaluates execution quality,
 * identifies lessons, and generates reward signals for learning.
 * Produces structured evaluations that feed into memory consolidation.
 */

import { getCognitiveOrchestrator } from "./orchestrator";
import { getStrategyManager } from "./strategyManager";
import { TaskEvaluation, PlanStep, AgentAction } from "./types";

export interface ExecutionMetrics {
  goalAchieved: boolean;
  planSuccessful: boolean;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  executionTime: number; // ms
  estimatedTime?: number; // ms
  userInterventions: number;
  correctionsMade: number;
  errorCount: number;
  recoveryCount: number;
}

const REWARD_SCALE = {
  SUCCESS: 2,
  PARTIAL_SUCCESS: 1,
  CORRECTED: -0.5,
  FAILED: -2,
  CANCELLED: 0,
};

const criticMetrics = {
  critic_catches: 0,
  critic_false_positives: 0,
};

export function getCriticMetrics(): Readonly<typeof criticMetrics> {
  return { ...criticMetrics };
}

export class TaskEvaluator {
  private cognitive = getCognitiveOrchestrator();
  private strategyManager = getStrategyManager();

  recordCriticOutcome(rejected: boolean, rejectionJustified: boolean): Readonly<typeof criticMetrics> {
    if (rejected) {
      criticMetrics.critic_catches += 1;
      if (!rejectionJustified) {
        criticMetrics.critic_false_positives += 1;
      }
    }
    return getCriticMetrics();
  }

  /**
   * Evaluate a completed task execution.
   */
  async evaluateExecution(options: {
    taskId: string;
    episodeId: string;
    goal: string;
    goalAchieved: boolean;
    plan?: PlanStep[];
    actions: AgentAction[];
    userInterventions: number;
    errors: any[];
    corrections: any[];
    executionTime: number;
    estimatedTime?: number;
    criticRejected?: boolean;
    criticRejectionJustified?: boolean;
  }): Promise<TaskEvaluation> {
    const startTime = Date.now();

    // Collect metrics
    const metrics = this.computeMetrics({
      goalAchieved: options.goalAchieved,
      planSuccessful:
        options.plan && options.plan.length > 0
          ? this.evaluatePlanExecution(
              options.plan,
              options.actions
            )
          : false,
      totalActions: options.actions.length,
      successfulActions: options.actions.filter(
        (a) => a.success
      ).length,
      failedActions: options.actions.filter(
        (a) => !a.success
      ).length,
      executionTime: options.executionTime,
      estimatedTime: options.estimatedTime,
      userInterventions: options.userInterventions,
      correctionsMade: options.corrections.length,
      errorCount: options.errors.length,
      recoveryCount: options.corrections.filter(
        (c) => c.correctionType === "auto_recovery"
      ).length,
    });

    // Generate reward
    let reward = REWARD_SCALE.CANCELLED;
    if (options.goalAchieved) {
      reward =
        options.userInterventions === 0
          ? REWARD_SCALE.SUCCESS
          : REWARD_SCALE.PARTIAL_SUCCESS;
    } else if (options.corrections.length > 0) {
      reward = REWARD_SCALE.CORRECTED;
    } else {
      reward = REWARD_SCALE.FAILED;
    }

    // Extract reasoning
    const reasoning = this.extractReasoning(
      metrics,
      options.goal,
      options.actions
    );

    // Calculate confidence
    const confidence = this.estimateConfidence(
      metrics,
      options.plan || []
    );

    // Calculate strategy quality
    const strategyQuality = this.evaluateStrategy(
      options.goal,
      metrics,
      confidence
    );

    if (options.criticRejected) {
      this.recordCriticOutcome(true, Boolean(options.criticRejectionJustified));
    }

    const evaluation: TaskEvaluation = {
      id: this.generateId(),
      taskId: options.taskId,
      episodeId: options.episodeId,
      evaluatedAt: Date.now(),
      metrics,
      reasoning,
      reward,
      strategyQuality,
      confidence,
      metadata: {
        evaluationTime: Date.now() - startTime,
        critic_catches: criticMetrics.critic_catches,
        critic_false_positives: criticMetrics.critic_false_positives,
      },
    };

    console.debug(
      `[TaskEvaluator] Evaluated task ${options.taskId}: reward=${reward}, confidence=${confidence}`
    );

    return evaluation;
  }

  /**
   * Compute execution metrics.
   */
  private computeMetrics(
    data: ExecutionMetrics
  ): TaskEvaluation["metrics"] {
    const timeEfficiency = data.estimatedTime
      ? Math.min(
          1,
          data.estimatedTime / data.executionTime
        )
      : undefined;

    return {
      goalAchieved: data.goalAchieved,
      planSuccessful: data.planSuccessful,
      unnecessaryActions: Math.max(
        0,
        data.totalActions - 5
      ), // Heuristic: more than 5 is inefficient
      userInterventions: data.userInterventions,
      totalErrors: data.errorCount,
      recoveredErrors: data.recoveryCount,
      executionTime: data.executionTime,
      estimatedTime: data.estimatedTime,
      timeEfficiency,
    };
  }

  /**
   * Evaluate how well plan was executed.
   */
  private evaluatePlanExecution(
    plan: PlanStep[],
    actions: AgentAction[]
  ): boolean {
    if (plan.length === 0 || actions.length === 0) {
      return false;
    }

    // Check if critical steps succeeded
    const criticalSteps = plan.filter((s) => s.critical);
    const criticalSuccess = criticalSteps.every(
      (step) =>
        actions.some(
          (a) =>
            a.tool === step.tool && a.success
        )
    );

    return criticalSuccess;
  }

  /**
   * Extract lessons learned.
   */
  private extractReasoning(
    metrics: TaskEvaluation["metrics"],
    goal: string,
    actions: AgentAction[]
  ): TaskEvaluation["reasoning"] {
    const lessons: string[] = [];
    const failures: string[] = [];
    const improvements: string[] = [];

    // Analyze success
    if (metrics.goalAchieved) {
      const totalActions = actions.length;
      const successfulActions = actions.filter(
        (a) => a.success
      ).length;
      const successRate = totalActions > 0
        ? successfulActions / totalActions
        : 1;
      if (successRate > 0.8) {
        lessons.push(
          "Plan execution was efficient and reliable"
        );
      } else {
        lessons.push(
          `Goal achieved with ${(successRate * 100).toFixed(0)}% action success rate`
        );
      }
    } else {
      failures.push(
        `Goal not achieved: ${goal}`
      );
    }

    // Analyze efficiency
    if (metrics.unnecessaryActions > 0) {
      improvements.push(
        `Reduce unnecessary actions (${metrics.unnecessaryActions} extra actions)`
      );
    }

    // Analyze errors
    if (metrics.totalErrors > 0) {
      failures.push(
        `${metrics.totalErrors} errors occurred`
      );
      if (metrics.recoveredErrors > 0) {
        lessons.push(
          `Recovered from ${metrics.recoveredErrors} errors`
        );
      }
    }

    // Analyze time
    if (metrics.timeEfficiency) {
      const pct = Math.round(
        metrics.timeEfficiency * 100
      );
      if (pct < 80) {
        improvements.push(
          `Performance: ${pct}% of estimated time (slower than expected)`
        );
      } else if (pct > 120) {
        improvements.push(
          `Performance: ${pct}% of estimated time (faster than expected)`
        );
      }
    }

    // Analyze user input
    if (metrics.userInterventions > 0) {
      improvements.push(
        `${metrics.userInterventions} user corrections needed`
      );
    }

    return {
      bestStrategy: goal,
      lessons: lessons.length > 0 ? lessons : undefined,
      failureCauses:
        failures.length > 0 ? failures : undefined,
      improvements:
        improvements.length > 0 ? improvements : undefined,
    };
  }

  /**
   * Estimate confidence in future similar tasks.
   */
  private estimateConfidence(
    metrics: TaskEvaluation["metrics"],
    plan: PlanStep[]
  ): number {
    let confidence = 0.5;

    // Increase for goal achievement
    if (metrics.goalAchieved) {
      confidence += 0.3;
    }

    // Increase for plan success
    if (metrics.planSuccessful) {
      confidence += 0.2;
    }

    // Decrease for errors
    confidence -= metrics.totalErrors * 0.05;

    // Decrease for user interventions
    confidence -=
      metrics.userInterventions * 0.1;

    // Increase for efficiency
    if (
      metrics.timeEfficiency &&
      metrics.timeEfficiency > 0.9
    ) {
      confidence += 0.1;
    }

    return Math.min(1, Math.max(0.1, confidence));
  }

  /**
   * Evaluate strategy quality based on execution.
   */
  private evaluateStrategy(
    goal: string,
    metrics: TaskEvaluation["metrics"],
    confidence: number
  ): number {
    let quality = 0.5;

    // Base on success
    if (metrics.goalAchieved) {
      quality += 0.3;
    }

    // Factor in efficiency
    if (metrics.unnecessaryActions === 0) {
      quality += 0.1;
    }

    // Factor in errors
    if (metrics.totalErrors === 0) {
      quality += 0.1;
    }

    // Factor in confidence
    quality *= confidence;

    return Math.min(1, quality);
  }

  /**
   * Generate learning signal for reinforcement learning.
   */
  generateLearningSignal(evaluation: TaskEvaluation): {
    strategyId: string;
    goalType: string;
    success: boolean;
    reward: number;
    durationMs: number;
    confidence: number;
  } {
    return {
      strategyId: this.generateId(),
      goalType:
        evaluation.reasoning.bestStrategy || "unknown",
      success: evaluation.metrics.goalAchieved,
      reward: evaluation.reward,
      durationMs: evaluation.metrics.executionTime,
      confidence: evaluation.confidence,
    };
  }

  /**
   * Generate memory consolidation input.
   */
  generateConsolidationInput(
    evaluation: TaskEvaluation
  ): {
    lessons: string[];
    patterns: string[];
    preferences: string[];
  } {
    const input = {
      lessons: evaluation.reasoning.lessons || [],
      patterns: [] as string[],
      preferences: [] as string[],
    };

    // Extract patterns
    if (evaluation.reasoning.improvements) {
      for (const imp of evaluation.reasoning.improvements) {
        if (imp.includes("reduce")) {
          input.patterns.push(
            "Unnecessary actions detected"
          );
        }
        if (imp.includes("faster")) {
          input.patterns.push(
            "Task executed faster than estimated"
          );
        }
      }
    }

    return input;
  }

  /**
   * Generate ID.
   */
  private generateId(): string {
    return `eval-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let evaluator: TaskEvaluator | null = null;

export function getTaskEvaluator(): TaskEvaluator {
  if (!evaluator) {
    evaluator = new TaskEvaluator();
  }
  return evaluator;
}
