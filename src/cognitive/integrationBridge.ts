/**
 * Cognitive Integration Bridge
 *
 * Connects the cognitive architecture to the backend server and task execution.
 * Orchestrates the full lifecycle: planning → execution → evaluation → learning.
 */

import {
  getCognitiveOrchestrator,
  getPlanningEngine,
  getStrategyManager,
  getTaskEvaluator,
  type Plan,
  type TaskEvaluation,
  type CognitiveContext,
  type EpisodicMemory,
} from "./index";

export interface TaskExecutionContext {
  taskId: string;
  conversationId?: string;
  goal: string;
  projectContext?: string;
  userInput: string;
  startTime: number;
  maxDuration?: number;
  requireApproval?: boolean;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  goalAchieved: boolean;
  plan: Plan | null;
  evaluation: TaskEvaluation | null;
  episode: EpisodicMemory | null;
  output: string;
  durationMs: number;
  reward: number;
}

export class CognitiveIntegrationBridge {
  private cognitive = getCognitiveOrchestrator();
  private planner = getPlanningEngine();
  private strategies = getStrategyManager();
  private evaluator = getTaskEvaluator();

  /**
   * Orchestrate full task lifecycle with cognitive systems.
   */
  async executeTaskWithCognition(
    context: TaskExecutionContext,
    executeFn: (
      plan: Plan,
      cognitiveContext: CognitiveContext
    ) => Promise<{
      actions: any[];
      errors: any[];
      corrections: any[];
      result: string;
    }>
  ): Promise<TaskExecutionResult> {
    const taskStartTime = Date.now();
    const result: TaskExecutionResult = {
      taskId: context.taskId,
      success: false,
      goalAchieved: false,
      plan: null,
      evaluation: null,
      episode: null,
      output: "",
      durationMs: 0,
      reward: 0,
    };

    try {
      // 1. BUILD COGNITIVE CONTEXT
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Building context for "${context.goal}"`
      );

      const cognitiveContext = await this.cognitive.buildContext(
        {
          goal: context.goal,
          projectContext: context.projectContext,
          maxMemories: 20,
        }
      );

      this.cognitive.setWorking("task_id", context.taskId);
      this.cognitive.setWorking("goal", context.goal);
      this.cognitive.setWorking(
        "user_input",
        context.userInput,
        { priority: 10 }
      );

      // 2. CREATE PLAN
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Creating plan`
      );

      const plan = await this.planner.createPlan(
        context.goal,
        {
          projectContext: context.projectContext,
          timeConstraint: context.maxDuration,
          requireApproval: context.requireApproval,
        }
      );
      result.plan = plan;

      this.cognitive.setWorking("plan", plan, {
        priority: 8,
      });

      // 3. SELECT STRATEGY
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Selecting strategy`
      );

      const strategySelection = this.strategies.selectStrategy(
        context.goal
      );
      if (strategySelection) {
        this.cognitive.setWorking("strategy", strategySelection, {
          priority: 7,
        });
      }

      // 4. EXECUTE WITH PLAN
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Executing task`
      );

      const executionStart = Date.now();
      let execution;
      try {
        execution = await executeFn(plan, cognitiveContext);
      } catch (error) {
        console.error(
          `[CognitiveIntegration] ${context.taskId}: Execution error:`,
          error
        );
        execution = {
          actions: [],
          errors: [{ message: String(error) }],
          corrections: [],
          result: `Error: ${error}`,
        };
      }
      const executionDuration =
        Date.now() - executionStart;

      result.output = execution.result;

      // 5. RECORD EXECUTION IN WORKING MEMORY
      this.cognitive.setWorking("execution_result", execution);
      this.cognitive.setWorking(
        "execution_duration",
        executionDuration
      );

      // 6. RECORD EPISODE
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Recording episode`
      );

      const goalAchieved =
        !execution.result.toLowerCase().includes("error") &&
        execution.corrections.length === 0 &&
        execution.errors.length === 0;
      result.goalAchieved = goalAchieved;

      const episode = this.cognitive.recordEpisode({
        taskId: context.taskId,
        conversationId: context.conversationId,
        title: context.goal,
        context: {
          goal: context.goal,
          environment: context.projectContext || "general",
          initialState: cognitiveContext.workingMemory,
          applications: [],
          files: [],
        },
        plan: {
          steps: plan.steps,
          estimatedDuration: plan.estimatedDuration,
        },
        execution: {
          actions: execution.actions || [],
          observations: [],
          errors: execution.errors || [],
          corrections: execution.corrections || [],
        },
        outcome: {
          success: goalAchieved,
          goalAchieved,
          completionTime: executionDuration,
          userIntervention:
            execution.corrections.length > 0,
          reward: goalAchieved ? 2 : -1,
        },
        lesson: {
          keyInsights: plan.reasoning.whyChosen
            ? [plan.reasoning.whyChosen]
            : [],
          failureModes: plan.reasoning.risks,
          successFactors: plan.reasoning.fallbacks,
        },
        metadata: {
          importance: goalAchieved ? 7 : 3,
          confidence: plan.confidence,
          tags: [context.goal],
          relatedMemories: [],
        },
      });
      result.episode = episode;

      // 7. EVALUATE TASK
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Evaluating task`
      );

      const evaluation = await this.evaluator.evaluateExecution({
        taskId: context.taskId,
        episodeId: episode.id,
        goal: context.goal,
        goalAchieved,
        plan: plan.steps,
        actions: execution.actions || [],
        userInterventions: execution.corrections?.length || 0,
        errors: execution.errors || [],
        corrections: execution.corrections || [],
        executionTime: executionDuration,
        estimatedTime: plan.estimatedDuration,
      });
      result.evaluation = evaluation;
      result.reward = evaluation.reward;

      // 8. RECORD LEARNING SIGNALS
      console.log(
        `[CognitiveIntegration] ${context.taskId}: Recording learning signals`
      );

      const strategyId =
        strategySelection?.selected.id ||
        `strategy-${context.goal}-${Date.now()}`;
      this.strategies.recordExecution(
        strategyId,
        context.goal,
        goalAchieved,
        executionDuration
      );

      if (goalAchieved) {
        this.cognitive.recordSkillSuccess(
          episode.id,
          executionDuration
        );
      } else {
        this.cognitive.recordSkillFailure(
          episode.id,
          executionDuration
        );
      }

      // 9. RECORD MILESTONE IF SIGNIFICANT
      if (evaluation.metrics.goalAchieved) {
        this.cognitive.recordMilestone(
          "event",
          `Successfully completed: ${context.goal}`,
          {
            significance: Math.min(
              10,
              Math.ceil(evaluation.confidence * 10)
            ),
            project: context.projectContext,
            relatedEpisodes: [episode.id],
            metadata: { taskId: context.taskId },
          }
        );
      }

      // 10. CLEAR WORKING MEMORY
      this.cognitive.clearWorking();

      result.success = true;
      result.durationMs = Date.now() - taskStartTime;

      console.log(
        `[CognitiveIntegration] ${context.taskId}: Task complete ` +
          `(success=${result.goalAchieved}, reward=${result.reward}, ` +
          `duration=${result.durationMs}ms)`
      );

      return result;
    } catch (error) {
      console.error(
        `[CognitiveIntegration] ${context.taskId}: Unexpected error:`,
        error
      );
      result.durationMs = Date.now() - taskStartTime;
      return result;
    }
  }

  /**
   * Get ready-to-use context for task planning.
   */
  async getPlanningContext(goal: string): Promise<CognitiveContext> {
    return this.cognitive.buildContext({
      goal,
      maxMemories: 20,
    });
  }

  /**
   * Get memory statistics for UI/diagnostics.
   */
  getMemoryStatistics() {
    return this.cognitive.getMemoryStats();
  }

  /**
   * Manually consolidate memories (learning pass).
   */
  async consolidateMemories() {
    return this.cognitive.consolidateMemories();
  }

  /**
   * Get active project context.
   */
  getProjectContext(project: string) {
    return this.cognitive.getProjectContext(project);
  }

  /**
   * Get work summary.
   */
  getWorkSummary(days: number = 1): string {
    return this.cognitive.getWorkSummary(days);
  }

  /**
   * Get user preferences.
   */
  getUserPreferences() {
    return this.cognitive.getUserPreferences();
  }

  /**
   * Get recent skills.
   */
  getRecentSkills(limit: number = 5) {
    return this.cognitive.getBestSkills("*", limit);
  }

  /**
   * Shutdown gracefully.
   */
  shutdown(): void {
    this.cognitive.shutdown();
    console.log("[CognitiveIntegration] Shutdown complete");
  }
}

// Singleton
let bridge: CognitiveIntegrationBridge | null = null;

export function getCognitiveIntegrationBridge(): CognitiveIntegrationBridge {
  if (!bridge) {
    bridge = new CognitiveIntegrationBridge();
  }
  return bridge;
}

export function resetCognitiveIntegrationBridge(): void {
  if (bridge) {
    bridge.shutdown();
  }
  bridge = new CognitiveIntegrationBridge();
}
