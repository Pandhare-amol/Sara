/**
 * Planning Engine
 *
 * Creates hierarchical plans for goals using memory, skills, and reasoning.
 * Decomposes goals into actionable steps with dependencies and alternatives.
 */

import { getCognitiveOrchestrator } from "./orchestrator";
import { PlanStep, ProceduralMemory } from "./types";

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  estimatedDuration: number; // ms
  confidence: number; // 0-1
  strategy: string; // Which strategy was selected
  alternatives: Plan[];
  reasoning: {
    selectedStrategy: string;
    whyChosen: string;
    risks: string[];
    fallbacks: string[];
  };
  created: number;
}

export interface PlanStrategy {
  name: string;
  description: string;
  applicableTo: string[]; // Goal keywords
  steps: Array<{
    description: string;
    tool?: string;
    alternatives?: string[];
  }>;
  successRate: number;
  averageDuration: number;
  confidence: number;
}

export class PlanningEngine {
  private cognitive = getCognitiveOrchestrator();
  private strategies: PlanStrategy[] = [];

  constructor() {
    this.initializeStrategies();
  }

  /**
   * Create a plan for a given goal.
   */
  async createPlan(
    goal: string,
    options: {
      projectContext?: string;
      timeConstraint?: number; // max ms
      requireApproval?: boolean;
      allowRisks?: boolean;
    } = {}
  ): Promise<Plan> {
    const startTime = Date.now();
    const planId = this.generateId();

    console.debug(
      `[PlanningEngine] Creating plan for: ${goal}`
    );

    // 1. Get cognitive context
    const context = await this.cognitive.buildContext({
      goal,
      projectContext: options.projectContext,
      maxMemories: 20,
    });

    // 2. Find similar past episodes
    const pastEpisodes = this.cognitive.getSimilarPastEpisodes(goal, 3);

    // 3. Find matching skills
    const matchingSkills = this.cognitive.getBestSkills(goal, 5);

    // 4. Select best strategy
    const selectedStrategy = this.selectStrategy(
      goal,
      matchingSkills,
      pastEpisodes
    );

    // 5. Generate plan steps
    let steps: PlanStep[] = [];
    if (selectedStrategy && matchingSkills.length > 0) {
      // Use learned skill
      steps = this.createStepsFromSkill(
        matchingSkills[0],
        goal
      );
    } else if (pastEpisodes.length > 0) {
      // Use past experience
      steps = this.createStepsFromEpisode(
        pastEpisodes[0],
        goal
      );
    } else {
      // Decompose goal
      steps = this.decomposeGoal(goal);
    }

    // 6. Add dependencies
    this.analyzeDependencies(steps);

    // 7. Estimate time and confidence
    const estimatedDuration = this.estimateDuration(steps);
    const confidence = this.estimateConfidence(
      steps,
      matchingSkills.length,
      pastEpisodes.length
    );

    // 8. Create alternatives
    const alternatives = this.generateAlternatives(
      goal,
      selectedStrategy,
      steps
    );

    const plan: Plan = {
      id: planId,
      goal,
      steps,
      estimatedDuration,
      confidence,
      strategy: selectedStrategy?.name || "decomposition",
      alternatives,
      reasoning: {
        selectedStrategy: selectedStrategy?.name || "decomposition",
        whyChosen: selectedStrategy
          ? `Based on ${selectedStrategy.successRate * 100}% success rate`
          : "No matching skills found, decomposing goal",
        risks: this.identifyRisks(steps, context),
        fallbacks: this.identifyFallbacks(steps),
      },
      created: Date.now(),
    };

    console.debug(
      `[PlanningEngine] Plan created in ${Date.now() - startTime}ms, confidence: ${confidence}`
    );

    return plan;
  }

  /**
   * Decompose a goal into sub-steps.
   */
  private decomposeGoal(goal: string): PlanStep[] {
    const steps: PlanStep[] = [];
    let index = 0;

    // Simple decomposition heuristic
    const goalLower = goal.toLowerCase();

    // Common patterns
    if (
      goalLower.includes("create") ||
      goalLower.includes("open")
    ) {
      steps.push({
        id: `step-${index++}`,
        index: 0,
        goal: "Take screenshot to see current state",
        action: "Observe environment",
        verifiable: true,
        critical: false,
      });
      steps.push({
        id: `step-${index++}`,
        index: 1,
        goal: "Execute main action",
        action: "Execute action",
        verifiable: true,
        critical: true,
      });
    } else if (goalLower.includes("find") || goalLower.includes("search")) {
      steps.push({
        id: `step-${index++}`,
        index: 0,
        goal: "Search for item",
        action: "Search",
        verifiable: true,
        critical: true,
      });
      steps.push({
        id: `step-${index++}`,
        index: 1,
        goal: "Verify result",
        action: "Verify",
        verifiable: true,
        critical: false,
      });
    } else {
      steps.push({
        id: `step-${index++}`,
        index: 0,
        goal: goal,
        action: "Execute",
        verifiable: true,
        critical: true,
      });
    }

    return steps;
  }

  /**
   * Create plan steps from a learned skill.
   */
  private createStepsFromSkill(
    skill: ProceduralMemory,
    goal: string
  ): PlanStep[] {
    return skill.steps.map((step, index) => ({
      id: `step-${index}`,
      index,
      goal: step.description,
      action: step.action,
      tool: step.action,
      args: step.args,
      expectedOutcome: step.expectedOutcome,
      dependencies: index > 0 ? [`step-${index - 1}`] : [],
      estimatedDuration: Math.ceil(
        skill.statistics.averageDuration /
          skill.steps.length
      ),
      critical: index === skill.steps.length - 1,
      verifiable: step.verifiable,
    }));
  }

  /**
   * Create plan steps from a past episode.
   */
  private createStepsFromEpisode(
    episode: any,
    goal: string
  ): PlanStep[] {
    return episode.execution.actions.map(
      (action: any, index: number) => ({
        id: `step-${index}`,
        index,
        goal: `Execute ${action.tool}`,
        action: action.tool,
        tool: action.tool,
        args: action.args,
        estimatedDuration: action.duration,
        dependencies:
          index > 0 ? [`step-${index - 1}`] : [],
        critical: false,
        verifiable: false,
      })
    );
  }

  /**
   * Select best strategy for goal.
   */
  private selectStrategy(
    goal: string,
    skills: ProceduralMemory[],
    episodes: any[]
  ): PlanStrategy | null {
    // Prefer skills with high success rates
    if (skills.length > 0) {
      const bestSkill = skills[0];
      return {
        name: bestSkill.name,
        description: bestSkill.description,
        applicableTo: [goal],
        steps: bestSkill.steps.map((s) => ({
          description: s.description,
          tool: s.action,
        })),
        successRate: bestSkill.statistics.successRate,
        averageDuration:
          bestSkill.statistics.averageDuration,
        confidence: bestSkill.confidence,
      };
    }

    // Prefer strategies with past successful episodes
    if (episodes.length > 0 && episodes[0].outcome.success) {
      return {
        name: `Past experience: ${goal}`,
        description: `Strategy based on previous successful execution`,
        applicableTo: [goal],
        steps: episodes[0].execution.actions.map(
          (a: any) => ({
            description: `Execute ${a.tool}`,
            tool: a.tool,
          })
        ),
        successRate: 0.7,
        averageDuration: episodes[0].outcome.completionTime,
        confidence: 0.6,
      };
    }

    return null;
  }

  /**
   * Analyze step dependencies.
   */
  private analyzeDependencies(steps: PlanStep[]): void {
    // Simple linear dependency model
    for (let i = 1; i < steps.length; i++) {
      if (!steps[i].dependencies) {
        steps[i].dependencies = [];
      }
      steps[i].dependencies!.push(
        steps[i - 1].id
      );
    }
  }

  /**
   * Estimate total duration.
   */
  private estimateDuration(steps: PlanStep[]): number {
    return steps.reduce(
      (sum, step) => sum + (step.estimatedDuration || 1000),
      0
    );
  }

  /**
   * Estimate confidence in plan success.
   */
  private estimateConfidence(
    steps: PlanStep[],
    skillMatches: number,
    episodeMatches: number
  ): number {
    let confidence = 0.5; // Base

    // Increase for past episodes
    confidence += episodeMatches * 0.15;

    // Increase for skills
    confidence += skillMatches * 0.1;

    // Decrease for steps without verification
    const unverifiable = steps.filter(
      (s) => !s.verifiable
    ).length;
    confidence -= (unverifiable / steps.length) * 0.2;

    return Math.min(1, Math.max(0.3, confidence));
  }

  /**
   * Generate alternative strategies.
   */
  private generateAlternatives(
    goal: string,
    selectedStrategy: PlanStrategy | null,
    originalSteps: PlanStep[]
  ): Plan[] {
    // For now, return empty alternatives
    // In production, this would generate 2-3 alternatives
    return [];
  }

  /**
   * Identify risks in plan.
   */
  private identifyRisks(
    steps: PlanStep[],
    context: any
  ): string[] {
    const risks: string[] = [];

    // Check for destructive actions
    const destructiveActions = [
      "delete",
      "remove",
      "format",
      "reset",
    ];
    for (const step of steps) {
      const toolLower = step.tool?.toLowerCase() || "";
      for (const action of destructiveActions) {
        if (toolLower.includes(action)) {
          risks.push(
            `${step.action} is destructive; may require confirmation`
          );
        }
      }
    }

    // Check for critical steps
    const criticalSteps = steps.filter((s) => s.critical);
    if (criticalSteps.length > 3) {
      risks.push("Plan has many critical steps; high failure risk");
    }

    return risks;
  }

  /**
   * Identify fallbacks.
   */
  private identifyFallbacks(steps: PlanStep[]): string[] {
    return [
      "Re-evaluate step with different approach",
      "Request user confirmation",
      "Revert to previous state if possible",
    ];
  }

  /**
   * Initialize built-in strategies.
   */
  private initializeStrategies(): void {
    // Strategies would be loaded from procedural memory
    // For now, empty
  }

  /**
   * Generate ID.
   */
  private generateId(): string {
    return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let planner: PlanningEngine | null = null;

export function getPlanningEngine(): PlanningEngine {
  if (!planner) {
    planner = new PlanningEngine();
  }
  return planner;
}
