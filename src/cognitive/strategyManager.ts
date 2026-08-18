/**
 * Strategy Manager
 *
 * Manages strategy selection based on experience and learning.
 * Uses reinforcement learning signals to favor strategies with high success rates.
 * Implements exploration vs exploitation tradeoff.
 */

import fs from "fs";
import path from "path";
import { dataFile } from "../../server_paths";

export interface StrategyRecord {
  id: string;
  name: string;
  goalType: string; // e.g., "open_application", "create_file"
  tools: string[];
  successCount: number;
  failureCount: number;
  totalExecutions: number;
  averageDuration: number; // ms
  successRate: number; // 0-1
  confidence: number; // 0-1
  lastUsed?: number;
  lastSucceeded?: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface StrategySelection {
  selected: StrategyRecord;
  alternatives: StrategyRecord[];
  confidence: number;
  reasoning: string;
}

const STRATEGIES_FILE = dataFile("strategies.json");
const EXPLORATION_RATE = 0.1; // 10% exploration
const CONFIDENCE_THRESHOLD = 0.6;
const MIN_EXECUTIONS = 2;

export class StrategyManager {
  private strategies: Map<string, StrategyRecord> = new Map();
  private indexByGoal: Map<string, Set<string>> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Record strategy execution result.
   */
  recordExecution(
    strategyId: string,
    goalType: string,
    success: boolean,
    durationMs: number
  ): StrategyRecord | null {
    let strategy = this.strategies.get(strategyId);

    if (!strategy) {
      // Create new strategy record
      strategy = {
        id: strategyId,
        name: `Strategy for ${goalType}`,
        goalType,
        tools: [],
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        totalExecutions: 1,
        averageDuration: durationMs,
        successRate: success ? 1 : 0,
        confidence: 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      };
    } else {
      // Update existing
      if (success) {
        strategy.successCount++;
        strategy.lastSucceeded = Date.now();
      } else {
        strategy.failureCount++;
      }
      strategy.totalExecutions++;
      strategy.averageDuration =
        (strategy.averageDuration *
          (strategy.totalExecutions - 1) +
          durationMs) /
        strategy.totalExecutions;
      strategy.successRate =
        strategy.successCount / strategy.totalExecutions;
      strategy.updatedAt = Date.now();
    }

    strategy.lastUsed = Date.now();

    // Update confidence based on success rate and sample size
    strategy.confidence = Math.min(
      1,
      Math.max(
        0.1,
        strategy.successRate +
          Math.min(
            0.3,
            strategy.totalExecutions * 0.05
          )
      )
    );

    this.strategies.set(strategyId, strategy);

    // Index by goal type
    const goalIds = this.indexByGoal.get(goalType) ||
      new Set();
    goalIds.add(strategyId);
    this.indexByGoal.set(goalType, goalIds);

    this.persist();
    return strategy;
  }

  /**
   * Get best strategy for a goal type.
   * Uses epsilon-greedy exploration vs exploitation.
   */
  selectStrategy(goalType: string): StrategySelection | null {
    const candidates = this.getStrategiesForGoal(goalType);

    if (candidates.length === 0) {
      return null;
    }

    // Epsilon-greedy: sometimes explore
    if (Math.random() < EXPLORATION_RATE) {
      const random =
        candidates[
          Math.floor(Math.random() * candidates.length)
        ];
      return {
        selected: random,
        alternatives: candidates.filter(
          (s) => s.id !== random.id
        ),
        confidence: random.confidence,
        reasoning: "Exploration: trying less-familiar strategy",
      };
    }

    // Exploitation: choose best
    const sorted = [...candidates].sort(
      (a, b) => b.successRate - a.successRate
    );
    const selected = sorted[0];

    return {
      selected,
      alternatives: sorted.slice(1),
      confidence: selected.confidence,
      reasoning: `Strategy with ${(selected.successRate * 100).toFixed(0)}% success rate (${selected.totalExecutions} executions)`,
    };
  }

  /**
   * Get strategies for a goal type sorted by quality.
   */
  private getStrategiesForGoal(
    goalType: string
  ): StrategyRecord[] {
    const ids = this.indexByGoal.get(goalType) || new Set();
    return Array.from(ids)
      .map((id) => this.strategies.get(id)!)
      .filter(
        (s) =>
          s && s.totalExecutions >= MIN_EXECUTIONS
      )
      .sort((a, b) => {
        // Sort by confidence, then success rate, then recency
        const confDiff = b.confidence - a.confidence;
        if (confDiff !== 0) return confDiff;
        const succDiff = b.successRate - a.successRate;
        if (succDiff !== 0) return succDiff;
        return (b.lastUsed || 0) - (a.lastUsed || 0);
      });
  }

  /**
   * Get all strategies.
   */
  list(limit?: number): StrategyRecord[] {
    const all = Array.from(this.strategies.values())
      .sort((a, b) => b.confidence - a.confidence);
    return limit ? all.slice(0, limit) : all;
  }

  /**
   * Get strategy by ID.
   */
  get(id: string): StrategyRecord | null {
    return this.strategies.get(id) || null;
  }

  /**
   * Get strategies with high success rate.
   */
  getReliable(minSuccessRate: number = 0.8): StrategyRecord[] {
    return Array.from(this.strategies.values())
      .filter(
        (s) =>
          s.successRate >= minSuccessRate &&
          s.totalExecutions >= MIN_EXECUTIONS
      )
      .sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * Get strategies that need improvement.
   */
  getNeedingImprovement(
    maxSuccessRate: number = 0.5
  ): StrategyRecord[] {
    return Array.from(this.strategies.values())
      .filter(
        (s) =>
          s.successRate <= maxSuccessRate &&
          s.totalExecutions >= MIN_EXECUTIONS
      )
      .sort((a, b) => a.successRate - b.successRate);
  }

  /**
   * Get recently used strategies.
   */
  getRecent(limit: number = 5): StrategyRecord[] {
    return Array.from(this.strategies.values())
      .filter((s) => s.lastUsed)
      .sort(
        (a, b) =>
          (b.lastUsed || 0) - (a.lastUsed || 0)
      )
      .slice(0, limit);
  }

  /**
   * Compare two strategies.
   */
  compare(
    id1: string,
    id2: string
  ): {
    better: StrategyRecord;
    worse: StrategyRecord;
    difference: number;
  } | null {
    const s1 = this.strategies.get(id1);
    const s2 = this.strategies.get(id2);

    if (!s1 || !s2) return null;

    const diff =
      (s1.successRate - s2.successRate) * 100;
    return {
      better: diff > 0 ? s1 : s2,
      worse: diff > 0 ? s2 : s1,
      difference: Math.abs(diff),
    };
  }

  /**
   * Get statistics.
   */
  getStatistics(): {
    total: number;
    averageSuccessRate: number;
    averageConfidence: number;
    totalExecutions: number;
    byGoalType: Record<string, number>;
  } {
    const strategies = Array.from(this.strategies.values());
    const stats = {
      total: strategies.length,
      averageSuccessRate: 0,
      averageConfidence: 0,
      totalExecutions: 0,
      byGoalType: {} as Record<string, number>,
    };

    let totalSuccess = 0;
    let totalConfidence = 0;

    for (const s of strategies) {
      totalSuccess += s.successRate;
      totalConfidence += s.confidence;
      stats.totalExecutions += s.totalExecutions;
      stats.byGoalType[s.goalType] =
        (stats.byGoalType[s.goalType] || 0) + 1;
    }

    if (strategies.length > 0) {
      stats.averageSuccessRate =
        totalSuccess / strategies.length;
      stats.averageConfidence =
        totalConfidence / strategies.length;
    }

    return stats;
  }

  /**
   * Delete a strategy.
   */
  delete(id: string): boolean {
    const strategy = this.strategies.get(id);
    if (!strategy) return false;

    this.indexByGoal
      .get(strategy.goalType)
      ?.delete(id);
    this.strategies.delete(id);
    this.persist();
    return true;
  }

  /**
   * Clear all strategies (testing).
   */
  clear(): void {
    this.strategies.clear();
    this.indexByGoal.clear();
    this.persist();
  }

  /**
   * Persist to disk.
   */
  private persist(): void {
    try {
      const data = Array.from(this.strategies.values());
      const dir = path.dirname(STRATEGIES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        STRATEGIES_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error(
        "[StrategyManager] Failed to persist:",
        error
      );
    }
  }

  /**
   * Load from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(STRATEGIES_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(STRATEGIES_FILE, "utf-8")
        );
        if (Array.isArray(data)) {
          this.strategies.clear();
          this.indexByGoal.clear();

          data.forEach((strategy) => {
            this.strategies.set(strategy.id, strategy);
            const ids = this.indexByGoal.get(
              strategy.goalType
            ) || new Set();
            ids.add(strategy.id);
            this.indexByGoal.set(strategy.goalType, ids);
          });

          console.debug(
            `[StrategyManager] Loaded ${this.strategies.size} strategies`
          );
        }
      }
    } catch (error) {
      console.error(
        "[StrategyManager] Failed to load:",
        error
      );
    }
  }
}

// Singleton
let manager: StrategyManager | null = null;

export function getStrategyManager(): StrategyManager {
  if (!manager) {
    manager = new StrategyManager();
  }
  return manager;
}
