/**
 * Memory Consolidation Engine
 *
 * Background process that consolidates episodic memories into
 * semantic and procedural memories. Detects patterns, learns skills,
 * and builds stable knowledge from experiences.
 */

import { getEpisodicMemory } from "./episodicMemory";
import { getSemanticMemory } from "./semanticMemory";
import { getProceduralMemory } from "./proceduralMemory";
import { getAutobiographicalMemory } from "./autobiographicalMemory";
import { EpisodicMemory, ProceduralMemory } from "./types";

const CONSOLIDATION_INTERVAL = 60 * 60 * 1000; // 1 hour
const MIN_EPISODES_FOR_PATTERN = 3;
const PATTERN_SIMILARITY_THRESHOLD = 0.7;

export class MemoryConsolidator {
  private timer: NodeJS.Timeout | null = null;
  private lastConsolidation: number = 0;
  private patternCache: Map<string, PatternRecord> = new Map();

  constructor() {
    this.start();
  }

  /**
   * Start automatic consolidation timer.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.consolidate(),
      CONSOLIDATION_INTERVAL
    );
    console.debug("[MemoryConsolidator] Started");
  }

  /**
   * Manually trigger consolidation.
   */
  async consolidate(): Promise<ConsolidationReport> {
    const startTime = Date.now();
    const episodic = getEpisodicMemory();
    const semantic = getSemanticMemory();
    const procedural = getProceduralMemory();
    const autobiographical = getAutobiographicalMemory();

    const report: ConsolidationReport = {
      timestamp: startTime,
      episodesAnalyzed: 0,
      patternsDetected: 0,
      skillsLearned: 0,
      preferencesLearned: 0,
      contradictionsDetected: 0,
      memoryArchivals: 0,
      duration: 0,
    };

    try {
      // 1. Analyze recent episodes
      const recentEpisodes = episodic.getByImportance(5, 50);
      report.episodesAnalyzed = recentEpisodes.length;

      // 2. Detect patterns in actions and outcomes
      const patterns = this.detectPatterns(recentEpisodes);
      report.patternsDetected = patterns.length;

      // 3. Create skills from reliable patterns
      for (const pattern of patterns) {
        const skill = this.createSkill(pattern);
        if (skill) {
          procedural.save(skill);
          report.skillsLearned++;
        }
      }

      // 4. Extract preferences from successful episodes
      const preferences = this.extractPreferences(recentEpisodes);
      for (const pref of preferences) {
        semantic.remember(
          "user_preference",
          pref.content,
          "preference",
          {
            source: "consolidation",
            confidence: pref.confidence,
            metadata: pref.metadata,
          }
        );
        report.preferencesLearned++;
      }

      // 5. Detect contradictions in knowledge
      const contradictions = this.detectContradictions(semantic);
      report.contradictionsDetected = contradictions.length;

      // 6. Archive low-value episodes
      const archived = this.archiveOldEpisodes(episodic);
      report.memoryArchivals = archived;

      // 7. Update autobiographical memory with significant patterns
      for (const pattern of patterns.filter((p) => p.significance >= 7)) {
        autobiographical.record("milestone", pattern.description, {
          significance: pattern.significance,
          metadata: {
            pattern: pattern,
            learnedAt: Date.now(),
          },
        });
      }

      this.lastConsolidation = Date.now();
      report.duration = Date.now() - startTime;

      console.debug(
        `[MemoryConsolidator] Consolidation complete: ${report.skillsLearned} skills, ${report.preferencesLearned} preferences`
      );

      return report;
    } catch (error) {
      console.error(
        "[MemoryConsolidator] Consolidation failed:",
        error
      );
      report.duration = Date.now() - startTime;
      return report;
    }
  }

  /**
   * Detect repeated patterns across episodes.
   */
  private detectPatterns(
    episodes: EpisodicMemory[]
  ): PatternRecord[] {
    const patterns: PatternRecord[] = [];

    if (episodes.length < MIN_EPISODES_FOR_PATTERN) {
      return patterns;
    }

    // Group episodes by similar goals
    const goalGroups = new Map<string, EpisodicMemory[]>();
    for (const ep of episodes) {
      const goalKey = this.normalizeGoal(ep.context.goal);
      if (!goalGroups.has(goalKey)) {
        goalGroups.set(goalKey, []);
      }
      goalGroups.get(goalKey)!.push(ep);
    }

    // Analyze each group for patterns
    for (const [goalKey, group] of goalGroups) {
      if (group.length < MIN_EPISODES_FOR_PATTERN) {
        continue;
      }

      // Calculate success rate
      const successes = group.filter((ep) => ep.outcome.success).length;
      const successRate = successes / group.length;

      // Extract common steps
      const commonSteps = this.findCommonSteps(group);

      // Calculate pattern significance
      const significance = Math.min(
        10,
        Math.ceil(
          successRate * 5 + // Success rate contributes up to 5
            Math.min(5, group.length) // More occurrences contribute up to 5
        )
      );

      if (commonSteps.length >= 2) {
        patterns.push({
          goal: goalKey,
          successRate,
          commonSteps,
          episodes: group.map((ep) => ep.id),
          significance,
          description: `Pattern: ${goalKey} (${group.length} times, ${(successRate * 100).toFixed(0)}% success)`,
          confidence: Math.min(1, successRate + group.length * 0.1),
        });
      }
    }

    return patterns;
  }

  /**
   * Extract user preferences from successful episodes.
   */
  private extractPreferences(
    episodes: EpisodicMemory[]
  ): Array<{
    content: string;
    confidence: number;
    metadata: Record<string, unknown>;
  }> {
    const preferences: Array<{
      content: string;
      confidence: number;
      metadata: Record<string, unknown>;
    }> = [];

    // Look for applications frequently used in successful tasks
    const appUsage = new Map<string, number>();
    for (const ep of episodes.filter((e) => e.outcome.success)) {
      if (ep.context.applications) {
        for (const app of ep.context.applications) {
          appUsage.set(app, (appUsage.get(app) || 0) + 1);
        }
      }
    }

    // Extract preferences for frequently used apps
    for (const [app, count] of appUsage) {
      if (count >= 2) {
        preferences.push({
          content: `Prefers using ${app} for task workflows`,
          confidence: Math.min(1, count * 0.15),
          metadata: { app, usageCount: count },
        });
      }
    }

    // Extract file/project preferences
    const fileUsage = new Map<string, number>();
    for (const ep of episodes.filter((e) => e.outcome.success)) {
      if (ep.context.files) {
        for (const file of ep.context.files) {
          fileUsage.set(file, (fileUsage.get(file) || 0) + 1);
        }
      }
    }

    for (const [file, count] of fileUsage) {
      if (count >= 2) {
        preferences.push({
          content: `Frequently works with ${file}`,
          confidence: Math.min(1, count * 0.1),
          metadata: { file, usageCount: count },
        });
      }
    }

    return preferences;
  }

  /**
   * Detect contradictions in semantic knowledge.
   */
  private detectContradictions(
    semantic: ReturnType<typeof getSemanticMemory>
  ): string[] {
    const contradictions: string[] = [];
    for (const mem of semantic.getPreferences()) {
      if (mem.contradictions && mem.contradictions.length > 0) {
        contradictions.push(mem.id);
      }
    }
    return contradictions;
  }

  /**
   * Archive old, low-significance episodes.
   */
  private archiveOldEpisodes(
    episodic: ReturnType<typeof getEpisodicMemory>
  ): number {
    let archived = 0;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    // Get low-importance old episodes
    for (const ep of episodic.list()) {
      if (
        ep.timestamp < thirtyDaysAgo &&
        ep.metadata.importance < 3
      ) {
        // In production, archive to cold storage
        // For now, just count
        archived++;
      }
    }

    return archived;
  }

  /**
   * Find common action sequences across episodes.
   */
  private findCommonSteps(
    episodes: EpisodicMemory[]
  ): string[] {
    if (episodes.length === 0) return [];

    // Extract action sequences from first episode
    const firstSequence = episodes[0].execution.actions
      .map((a) => a.tool)
      .join(" -> ");

    // Check how many other episodes have similar sequence
    const commonSteps: string[] = [];
    const toolCounts = new Map<string, number>();

    for (const ep of episodes) {
      for (const action of ep.execution.actions) {
        toolCounts.set(
          action.tool,
          (toolCounts.get(action.tool) || 0) + 1
        );
      }
    }

    // Return tools that appear in most episodes
    const threshold = episodes.length * 0.6; // 60% of episodes
    for (const [tool, count] of toolCounts) {
      if (count >= threshold) {
        commonSteps.push(tool);
      }
    }

    return commonSteps;
  }

  /**
   * Create a skill from a pattern.
   */
  private createSkill(pattern: PatternRecord): ProceduralMemory | null {
    if (pattern.commonSteps.length === 0) {
      return null;
    }

    return {
      id: this.generateId(),
      name: `Learned: ${pattern.goal}`,
      description: `Auto-learned procedure for: ${pattern.goal}`,
      category: "learned",
      steps: pattern.commonSteps.map((tool, i) => ({
        id: `step-${i}`,
        index: i,
        description: `Execute ${tool}`,
        action: tool,
        args: {},
        verifiable: true,
      })),
      preconditions: [],
      postconditions: [],
      requiredTools: pattern.commonSteps,
      requiredPermissions: [],
      parameters: [],
      statistics: {
        timesExecuted: pattern.episodes.length,
        successCount: Math.floor(
          pattern.episodes.length * pattern.successRate
        ),
        failureCount: Math.floor(
          pattern.episodes.length * (1 - pattern.successRate)
        ),
        averageDuration: 0,
        successRate: pattern.successRate,
      },
      confidence: pattern.confidence,
      knownFailureModes: [],
      version: "1.0",
      metadata: { autoLearned: true, pattern },
    };
  }

  /**
   * Normalize goal description for grouping.
   */
  private normalizeGoal(goal: string): string {
    return goal
      .toLowerCase()
      .replace(/[0-9]+/g, "N")
      .trim();
  }

  /**
   * Generate ID.
   */
  private generateId(): string {
    return `cons-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Stop consolidation.
   */
  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get last consolidation time.
   */
  getLastConsolidation(): number {
    return this.lastConsolidation;
  }
}

export interface PatternRecord {
  goal: string;
  successRate: number;
  commonSteps: string[];
  episodes: string[];
  significance: number;
  description: string;
  confidence: number;
}

export interface ConsolidationReport {
  timestamp: number;
  episodesAnalyzed: number;
  patternsDetected: number;
  skillsLearned: number;
  preferencesLearned: number;
  contradictionsDetected: number;
  memoryArchivals: number;
  duration: number;
}

// Singleton
let consolidator: MemoryConsolidator | null = null;

export function getMemoryConsolidator(): MemoryConsolidator {
  if (!consolidator) {
    consolidator = new MemoryConsolidator();
  }
  return consolidator;
}
