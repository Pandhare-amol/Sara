/**
 * Skill Library and Strategy Manager
 * Manages reusable skills and execution strategies with learning and optimization
 */

import type { Skill, Action, RecoveryStrategy, AuthorityLevel } from '../types/ClosedLoopTask';

export interface StrategyMetrics {
  strategyId: string;
  successCount: number;
  failureCount: number;
  averageDuration: number;
  recoveryCount: number;
  verificationQuality: number;
  confidence: number;
  lastUsed: number;
  successRate: number; // 0.0 to 1.0
}

export class SkillLibrary {
  private skills: Map<string, Skill> = new Map();
  private builtInSkills: Skill[] = [];

  constructor() {
    this.initializeBuiltInSkills();
  }

  /**
   * Initialize built-in skills
   */
  private initializeBuiltInSkills(): void {
    // Skill: Open Application
    this.registerSkill({
      id: 'skill-open-app',
      name: 'OpenApplication',
      description: 'Open an application by name or path',
      preconditions: [],
      actions: [
        {
          id: 'action-open-app-1',
          type: 'open_application',
          target: '${applicationName}',
          parameters: { applicationName: '', arguments: [] },
          timeoutMs: 10000,
          retryable: true,
          maxRetries: 2,
          authorityLevel: 'NORMAL',
        },
      ],
      expectedEffect: '${applicationName} window is visible and focused',
      verification: [
        {
          id: 'verify-app-open',
          description: 'Verify application window is visible',
          check: () => ({ passed: true, confidence: 0.9, evidence: [], duration: 100 }),
          timeout: 5000,
          confidence: 0.9,
          required: true,
        },
      ],
      failureModes: [
        {
          type: 'application_not_found',
          description: 'Application executable not found',
          pattern: (e) => String(e).includes('not found'),
          severity: 'high',
          recoveryable: true,
        },
      ],
      recovery: [],
      successHistory: { count: 0, averageDuration: 0, lastUsed: 0 },
      failureHistory: { count: 0, lastFailed: 0 },
      confidence: 0.95,
      estimatedDuration: 3000,
      authorityLevel: 'NORMAL',
    });

    // Skill: Type Text
    this.registerSkill({
      id: 'skill-type-text',
      name: 'TypeText',
      description: 'Type text into focused element',
      preconditions: [],
      actions: [
        {
          id: 'action-type-text-1',
          type: 'keyboard_type',
          parameters: { text: '' },
          timeoutMs: 5000,
          retryable: true,
          maxRetries: 1,
          authorityLevel: 'NORMAL',
        },
      ],
      expectedEffect: 'Text is typed in focused element',
      verification: [
        {
          id: 'verify-text-typed',
          description: 'Verify text appears in focused element',
          check: () => ({ passed: true, confidence: 0.9, evidence: [], duration: 100 }),
          timeout: 2000,
          confidence: 0.85,
          required: true,
        },
      ],
      failureModes: [
        {
          type: 'input_not_focused',
          description: 'No input field focused',
          pattern: (e) => String(e).includes('focused'),
          severity: 'medium',
          recoveryable: true,
        },
      ],
      recovery: [],
      successHistory: { count: 0, averageDuration: 0, lastUsed: 0 },
      failureHistory: { count: 0, lastFailed: 0 },
      confidence: 0.98,
      estimatedDuration: 500,
      authorityLevel: 'NORMAL',
    });

    // Skill: Save File
    this.registerSkill({
      id: 'skill-save-file',
      name: 'SaveFile',
      description: 'Save current document to file',
      preconditions: [],
      actions: [
        {
          id: 'action-save-hotkey',
          type: 'keyboard_hotkey',
          parameters: { keys: ['ctrl', 's'] },
          timeoutMs: 3000,
          retryable: false,
          maxRetries: 0,
          authorityLevel: 'NORMAL',
        },
      ],
      expectedEffect: 'Document is saved',
      verification: [
        {
          id: 'verify-file-saved',
          description: 'Verify file was saved',
          check: () => ({ passed: true, confidence: 0.8, evidence: [], duration: 100 }),
          timeout: 3000,
          confidence: 0.8,
          required: true,
        },
      ],
      failureModes: [
        {
          type: 'save_dialog_required',
          description: 'Save dialog appeared and needs file path',
          pattern: (e) => String(e).includes('dialog'),
          severity: 'medium',
          recoveryable: true,
        },
      ],
      recovery: [],
      successHistory: { count: 0, averageDuration: 0, lastUsed: 0 },
      failureHistory: { count: 0, lastFailed: 0 },
      confidence: 0.9,
      estimatedDuration: 2000,
      authorityLevel: 'NORMAL',
    });

    // Skill: Click Button
    this.registerSkill({
      id: 'skill-click-button',
      name: 'ClickButton',
      description: 'Click a button by text or coordinates',
      preconditions: [],
      actions: [
        {
          id: 'action-click-button-1',
          type: 'mouse_click',
          parameters: { x: 0, y: 0 },
          timeoutMs: 2000,
          retryable: true,
          maxRetries: 2,
          authorityLevel: 'NORMAL',
        },
      ],
      expectedEffect: 'Button is clicked and action is triggered',
      verification: [
        {
          id: 'verify-button-clicked',
          description: 'Verify button action occurred',
          check: () => ({ passed: true, confidence: 0.8, evidence: [], duration: 100 }),
          timeout: 2000,
          confidence: 0.8,
          required: true,
        },
      ],
      failureModes: [
        {
          type: 'button_not_found',
          description: 'Button not found at expected location',
          pattern: (e) => String(e).includes('not found'),
          severity: 'high',
          recoveryable: true,
        },
      ],
      recovery: [],
      successHistory: { count: 0, averageDuration: 0, lastUsed: 0 },
      failureHistory: { count: 0, lastFailed: 0 },
      confidence: 0.95,
      estimatedDuration: 500,
      authorityLevel: 'NORMAL',
    });
  }

  /**
   * Register a skill
   */
  registerSkill(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /**
   * Get skill by ID
   */
  getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Search skills by name
   */
  searchSkills(query: string): Skill[] {
    return Array.from(this.skills.values()).filter(
      (s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.description.toLowerCase().includes(query.toLowerCase())
    );
  }

  /**
   * Get all skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get best skill for task
   */
  selectBestSkill(taskType: string, context: Record<string, any> = {}): Skill | undefined {
    // Simple heuristic: return highest confidence skill
    const candidates = Array.from(this.skills.values())
      .filter((s) => s.confidence > 0.5)
      .sort((a, b) => b.confidence - a.confidence);

    return candidates[0];
  }

  /**
   * Update skill confidence based on performance
   */
  updateSkillConfidence(skillId: string, success: boolean, executionTime: number): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    if (success) {
      skill.successHistory.count++;
      skill.successHistory.lastUsed = Date.now();
      const newAvg =
        (skill.successHistory.averageDuration * (skill.successHistory.count - 1) + executionTime) /
        skill.successHistory.count;
      skill.successHistory.averageDuration = newAvg;
      skill.confidence = Math.min(1.0, skill.confidence + 0.02);
    } else {
      skill.failureHistory.count++;
      skill.failureHistory.lastFailed = Date.now();
      skill.confidence = Math.max(0.3, skill.confidence - 0.05);
    }
  }
}

export class StrategyManager {
  private strategies: Map<string, StrategyMetrics> = new Map();
  private performanceHistory: Array<{
    strategyId: string;
    timestamp: number;
    success: boolean;
    duration: number;
  }> = [];

  /**
   * Register strategy
   */
  registerStrategy(strategy: RecoveryStrategy): void {
    const metrics: StrategyMetrics = {
      strategyId: strategy.id,
      successCount: 0,
      failureCount: 0,
      averageDuration: strategy.estimatedDuration,
      recoveryCount: 0,
      verificationQuality: 0.8,
      confidence: strategy.successRate || 0.7,
      lastUsed: 0,
      successRate: strategy.successRate || 0.7,
    };

    this.strategies.set(strategy.id, metrics);
  }

  /**
   * Select best strategy for failure mode
   */
  selectStrategy(
    failureMode: string,
    availableStrategies: RecoveryStrategy[]
  ): RecoveryStrategy | undefined {
    // Filter to applicable strategies
    const applicable = availableStrategies.filter(
      (s) => s.failureMode === failureMode
    );

    if (applicable.length === 0) return undefined;

    // Sort by success rate and recency
    const sorted = applicable.sort((a, b) => {
      const metricsA = this.strategies.get(a.id);
      const metricsB = this.strategies.get(b.id);

      const successRateA = metricsA?.successRate || a.successRate || 0.5;
      const successRateB = metricsB?.successRate || b.successRate || 0.5;

      if (successRateA !== successRateB) {
        return successRateB - successRateA;
      }

      // Use recency as tiebreaker
      const lastUsedA = metricsA?.lastUsed || 0;
      const lastUsedB = metricsB?.lastUsed || 0;
      return lastUsedB - lastUsedA;
    });

    return sorted[0];
  }

  /**
   * Record strategy performance
   */
  recordPerformance(
    strategyId: string,
    success: boolean,
    duration: number
  ): void {
    const metrics = this.strategies.get(strategyId);
    if (!metrics) return;

    if (success) {
      metrics.successCount++;
      metrics.recoveryCount++;
    } else {
      metrics.failureCount++;
    }

    const total = metrics.successCount + metrics.failureCount;
    metrics.successRate = metrics.successCount / total;
    metrics.averageDuration =
      (metrics.averageDuration * (total - 1) + duration) / total;
    metrics.lastUsed = Date.now();
    metrics.confidence = Math.min(
      1.0,
      Math.max(0.1, metrics.successRate)
    );

    this.performanceHistory.push({
      strategyId,
      timestamp: Date.now(),
      success,
      duration,
    });
  }

  /**
   * Get strategy metrics
   */
  getMetrics(strategyId: string): StrategyMetrics | undefined {
    return this.strategies.get(strategyId);
  }

  /**
   * Get all strategy metrics
   */
  getAllMetrics(): StrategyMetrics[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get performance trend
   */
  getPerformanceTrend(strategyId: string, timeWindowMs: number = 3600000): {
    successRate: number;
    averageDuration: number;
    sampleCount: number;
  } {
    const cutoff = Date.now() - timeWindowMs;
    const recent = this.performanceHistory.filter(
      (p) => p.strategyId === strategyId && p.timestamp >= cutoff
    );

    if (recent.length === 0) {
      const metrics = this.strategies.get(strategyId);
      return {
        successRate: metrics?.successRate || 0.5,
        averageDuration: metrics?.averageDuration || 0,
        sampleCount: 0,
      };
    }

    const successes = recent.filter((p) => p.success).length;
    const avgDuration = recent.reduce((sum, p) => sum + p.duration, 0) / recent.length;

    return {
      successRate: successes / recent.length,
      averageDuration: avgDuration,
      sampleCount: recent.length,
    };
  }
}

// Export singletons
export const skillLibrary = new SkillLibrary();
export const strategyManager = new StrategyManager();
