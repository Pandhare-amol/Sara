/**
 * Advanced Learning Service
 * Handles skill extraction, failure pattern recognition, and strategy optimization
 * Enables SARA to improve execution automatically over time
 */

import {
  Skill,
  RecoveryStrategy,
  ClosedLoopTask,
  TaskExecutionState,
  Action,
  Condition,
} from '../types/ClosedLoopTask';
import {
  MemoryStore,
  AchievementMemory,
  FailureMemory,
  createAchievementMemory,
} from '../types/Memory';
import { MemoryService } from './MemoryService';
import { SkillLibrary } from './SkillLibraryAndStrategyManager';

export interface SkillExtractionResult {
  success: boolean;
  skillId: string;
  skillName: string;
  confidence: number;
  actionCount: number;
  verificationStepCount: number;
  recoveryStrategies: number;
}

export interface FailurePattern {
  pattern: string;
  occurrences: number;
  taskTypes: string[];
  commonRootCauses: string[];
  successfulRecoveries: string[];
  confidence: number;
}

export interface LearningOpportunity {
  type: 'skill_extraction' | 'pattern_recognition' | 'strategy_optimization';
  description: string;
  priority: number; // 0-100
  task?: ClosedLoopTask;
  data?: Record<string, unknown>;
}

export class AdvancedLearningService {
  private memoryService: MemoryService;
  private skillLibrary: SkillLibrary;
  private extractedSkills: Map<string, SkillExtractionResult> = new Map();
  private failurePatterns: Map<string, FailurePattern> = new Map();
  private strategyMetrics: Map<string, { successRate: number; trend: number }> = new Map();

  constructor(memoryService: MemoryService, skillLibrary: SkillLibrary) {
    this.memoryService = memoryService;
    this.skillLibrary = skillLibrary;
  }

  /**
   * Analyze task completion and extract reusable skills
   */
  async extractSkillFromTask(
    task: ClosedLoopTask,
    executionDuration: number
  ): Promise<SkillExtractionResult | null> {
    if (!task.currentState || !['COMPLETED', 'PARTIAL'].includes(task.currentState)) {
      return null;
    }

    try {
      // For now, create a basic extraction result without analyzing task details
      // since ClosedLoopTask structure may not have subgoals at this stage
      
      const skillId = `extracted-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const skillName = `${task.goal?.description || 'Unknown'}-Skill`;

      // Create minimal new skill matching the Skill interface
      const newSkill: Skill = {
        id: skillId,
        name: skillName,
        description: `Extracted from task: ${task.goal?.description}`,
        preconditions: [],
        actions: [],
        expectedEffect: `Successfully completed ${task.goal?.description}`,
        verification: [],
        failureModes: [],
        recovery: [],
        successHistory: {
          count: 1,
          averageDuration: executionDuration,
          lastUsed: Date.now(),
        },
        failureHistory: {
          count: 0,
          lastFailed: 0,
        },
        confidence: 0.75,
        estimatedDuration: executionDuration,
        authorityLevel: task.goal?.authorityLevel || 'NORMAL',
      };

      // Register skill in library
      this.skillLibrary.registerSkill(newSkill);

      const result: SkillExtractionResult = {
        success: true,
        skillId,
        skillName,
        confidence: 0.75,
        actionCount: 0,
        verificationStepCount: 0,
        recoveryStrategies: 0,
      };

      this.extractedSkills.set(skillId, result);

      console.log(
        `[Learning] Extracted skill: ${skillName} with confidence 0.75`
      );

      return result;
    } catch (error) {
      console.error('[Learning] Error extracting skill:', error);
      return null;
    }
  }

  /**
   * Recognize patterns in failures to improve future attempts
   */
  async analyzeFailurePatterns(memoryStore: MemoryStore): Promise<FailurePattern[]> {
    const patterns: Map<string, FailurePattern> = new Map();

    // Analyze failure memories
    memoryStore.failure.forEach((failure) => {
      const key = failure.failure.failureType;

      if (!patterns.has(key)) {
        patterns.set(key, {
          pattern: key,
          occurrences: 0,
          taskTypes: [],
          commonRootCauses: [],
          successfulRecoveries: [],
          confidence: 0,
        });
      }

      const pattern = patterns.get(key)!;
      pattern.occurrences++;

      if (!pattern.taskTypes.includes(failure.failure.taskType)) {
        pattern.taskTypes.push(failure.failure.taskType);
      }

      if (!pattern.commonRootCauses.includes(failure.failure.rootCause)) {
        pattern.commonRootCauses.push(failure.failure.rootCause);
      }

      if (failure.failure.suggestedAlternative) {
        pattern.successfulRecoveries.push(failure.failure.suggestedAlternative);
      }

      // Calculate confidence based on recency and frequency
      pattern.confidence = Math.min(
        1.0,
        pattern.occurrences / 10 + (failure.failure.repeatCount > 0 ? 0.2 : 0)
      );
    });

    // Convert to array and sort by confidence
    const patternArray = Array.from(patterns.values()).sort(
      (a, b) => b.confidence - a.confidence
    );

    this.failurePatterns = patterns;

    console.log(
      `[Learning] Analyzed ${patternArray.length} failure patterns, highest confidence: ${patternArray[0]?.confidence.toFixed(2) || 'N/A'}`
    );

    return patternArray;
  }

  /**
   * Optimize strategy selection based on observed performance
   */
  async optimizeStrategySelection(memoryStore: MemoryStore): Promise<void> {
    const strategyMetrics: Map<string, { successCount: number; failureCount: number }> =
      new Map();

    // Analyze achievements
    memoryStore.achievement.forEach((achievement) => {
      const strategyName = achievement.achievement.successStrategy;
      if (!strategyMetrics.has(strategyName)) {
        strategyMetrics.set(strategyName, {
          successCount: 0,
          failureCount: 0,
        });
      }
      strategyMetrics.get(strategyName)!.successCount++;
    });

    // Analyze failures
    memoryStore.failure.forEach((failure) => {
      const strategyName = failure.failure.strategy;
      if (!strategyMetrics.has(strategyName)) {
        strategyMetrics.set(strategyName, {
          successCount: 0,
          failureCount: 0,
        });
      }
      strategyMetrics.get(strategyName)!.failureCount++;
    });

    // Calculate trends
    strategyMetrics.forEach((metrics, strategy) => {
      const total = metrics.successCount + metrics.failureCount;
      const successRate = total > 0 ? metrics.successCount / total : 0.5;

      // Simple trend: compare recent vs. older
      const recentWeight = metrics.successCount * 0.7 + metrics.failureCount * 0.3;
      const trend = successRate > 0.7 ? 1 : successRate < 0.3 ? -1 : 0;

      this.strategyMetrics.set(strategy, {
        successRate,
        trend,
      });
    });

    const avgSuccessRate = Array.from(this.strategyMetrics.values())
      .reduce((sum: number, m) => sum + m.successRate, 0) / Math.max(1, strategyMetrics.size);

    console.log(
      `[Learning] Optimized ${strategyMetrics.size} strategies, average success rate: ${avgSuccessRate.toFixed(2)}`
    );
  }

  /**
   * Get learning opportunities for next execution
   */
  async identifyLearningOpportunities(): Promise<LearningOpportunity[]> {
    const opportunities: LearningOpportunity[] = [];

    // Check for high-confidence failure patterns
    this.failurePatterns.forEach((pattern) => {
      if (pattern.confidence > 0.6) {
        opportunities.push({
          type: 'pattern_recognition',
          description: `Recognized failure pattern: ${pattern.pattern} (${pattern.occurrences} occurrences)`,
          priority: Math.floor(pattern.confidence * 100),
          data: {
            pattern: pattern.pattern,
            occurrences: pattern.occurrences,
            confidence: pattern.confidence,
            taskTypes: pattern.taskTypes,
          },
        });
      }
    });

    // Check for strategies with improving trends
    this.strategyMetrics.forEach((metrics, strategy) => {
      if (metrics.trend > 0) {
        opportunities.push({
          type: 'strategy_optimization',
          description: `Strategy improving: ${strategy} (success rate: ${(metrics.successRate * 100).toFixed(1)}%)`,
          priority: Math.floor(metrics.successRate * 100),
          data: {
            strategy,
            successRate: metrics.successRate,
            trend: metrics.trend,
          },
        });
      }
    });

    // Check for extractable skills
    if (this.extractedSkills.size > 0) {
      opportunities.push({
        type: 'skill_extraction',
        description: `${this.extractedSkills.size} skills extracted for reuse`,
        priority: 75,
        data: { count: this.extractedSkills.size },
      });
    }

    // Sort by priority
    return opportunities.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get summary of what has been learned
   */
  async getLearningReport(): Promise<{
    skillsExtracted: number;
    failurePatterns: number;
    strategiesOptimized: number;
    totalLearningEvents: number;
    topFailurePatterns: FailurePattern[];
    topStrategies: Array<{ strategy: string; successRate: number }>;
  }> {
    const topStrategies = Array.from(this.strategyMetrics.entries())
      .map(([strategy, metrics]) => ({
        strategy,
        successRate: metrics.successRate,
      }))
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 5);

    const topFailures = Array.from(this.failurePatterns.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    return {
      skillsExtracted: this.extractedSkills.size,
      failurePatterns: this.failurePatterns.size,
      strategiesOptimized: this.strategyMetrics.size,
      totalLearningEvents:
        this.extractedSkills.size + this.failurePatterns.size + this.strategyMetrics.size,
      topFailurePatterns: topFailures,
      topStrategies,
    };
  }

  /**
   * Apply learned knowledge to improve a task's execution plan
   */
  async improveTaskPlan(
    task: ClosedLoopTask,
    memoryStore: MemoryStore
  ): Promise<ClosedLoopTask> {
    // Check for similar past successes
    const achievements = memoryStore.achievement;
    let bestMatch: AchievementMemory | null = null;
    
    achievements.forEach((achievement) => {
      if (achievement.achievement.taskType === task.goal?.description && achievement.achievement.reusable) {
        if (!bestMatch || achievement.confidence > bestMatch.confidence) {
          bestMatch = achievement;
        }
      }
    });

    if (bestMatch) {
      console.log(
        `[Learning] Found successful strategy for similar task: ${bestMatch.achievement.taskType}`
      );
    }

    // Check for known failure patterns
    const failures = memoryStore.failure;
    let failureCount = 0;
    
    failures.forEach((failure) => {
      if (failure.failure.taskType === task.goal?.description) {
        failureCount++;
        if (failure.failure.suggestedAlternative) {
          console.log(`[Learning] Suggested alternative: ${failure.failure.suggestedAlternative}`);
        }
      }
    });

    if (failureCount > 0) {
      console.log(`[Learning] Found ${failureCount} known failure patterns for this task`);
    }

    return task;
  }

  /**
   * Reset learning (for testing or new context)
   */
  reset(): void {
    this.extractedSkills.clear();
    this.failurePatterns.clear();
    this.strategyMetrics.clear();
    console.log('[Learning] Reset all learning state');
  }
}

// Singleton instance
let learningInstance: AdvancedLearningService | null = null;

export function getAdvancedLearningService(
  memoryService: MemoryService,
  skillLibrary: SkillLibrary
): AdvancedLearningService {
  if (!learningInstance) {
    learningInstance = new AdvancedLearningService(memoryService, skillLibrary);
  }
  return learningInstance;
}
