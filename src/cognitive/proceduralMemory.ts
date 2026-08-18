/**
 * Procedural Memory System
 *
 * Stores skills and procedures: reusable workflows with success tracking,
 * failure modes, execution statistics, and confidence.
 */

import fs from "fs";
import path from "path";
import { dataFile } from "../../server_paths";
import { ProceduralMemory, ProcedureStep } from "./types";

const PROCEDURAL_MEMORY_FILE = dataFile("procedural_memories.json");

export class ProceduralMemoryEngine {
  private memories: Map<string, ProceduralMemory> = new Map();
  private indexByCategory: Map<string, Set<string>> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Create or update a procedure/skill.
   */
  save(procedure: Omit<ProceduralMemory, "id" | "lastExecuted">): ProceduralMemory {
    // Check if updating existing
    const existing = Array.from(this.memories.values()).find(
      (p) =>
        p.name.toLowerCase() === procedure.name.toLowerCase() &&
        p.category === procedure.category
    );

    const mem: ProceduralMemory = {
      ...procedure,
      id: existing?.id || this.generateId(),
      lastExecuted: existing?.lastExecuted,
    };

    this.memories.set(mem.id, mem);
    this.indexByCategory
      .get(procedure.category)
      ?.add(mem.id) ||
      this.indexByCategory.set(
        procedure.category,
        new Set([mem.id])
      );

    this.persist();
    return mem;
  }

  /**
   * Get a procedure by ID.
   */
  get(id: string): ProceduralMemory | null {
    return this.memories.get(id) || null;
  }

  /**
   * Get by name.
   */
  getByName(name: string): ProceduralMemory | null {
    return (
      Array.from(this.memories.values()).find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      ) || null
    );
  }

  /**
   * Get all procedures in a category.
   */
  getByCategory(category: string): ProceduralMemory[] {
    const ids = this.indexByCategory.get(category) || new Set();
    return Array.from(ids)
      .map((id) => this.memories.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.statistics.successRate - a.statistics.successRate);
  }

  /**
   * Search procedures by name, description, or keywords.
   */
  search(query: string, limit: number = 10): ProceduralMemory[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.memories.values())
      .map((proc) => {
        let score = 0;
        if (proc.name.toLowerCase().includes(q)) score += 5;
        if (proc.description.toLowerCase().includes(q)) score += 3;
        // Score steps
        proc.steps.forEach((step) => {
          if (step.description.toLowerCase().includes(q)) score += 1;
        });
        score *= proc.statistics.successRate;
        score += proc.confidence;
        return { proc, score };
      })
      .filter(({ score }) => score > 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ proc }) => proc);
  }

  /**
   * Get all procedures sorted by success rate.
   */
  list(limit?: number): ProceduralMemory[] {
    const sorted = Array.from(this.memories.values()).sort(
      (a, b) => b.statistics.successRate - a.statistics.successRate
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Record successful execution.
   */
  recordSuccess(
    id: string,
    executionTimeMs: number
  ): ProceduralMemory | null {
    const proc = this.memories.get(id);
    if (!proc) return null;

    proc.statistics.timesExecuted++;
    proc.statistics.successCount++;
    proc.statistics.averageDuration =
      (proc.statistics.averageDuration *
        (proc.statistics.timesExecuted - 1) +
        executionTimeMs) /
      proc.statistics.timesExecuted;
    proc.statistics.successRate =
      proc.statistics.successCount / proc.statistics.timesExecuted;
    proc.lastExecuted = Date.now();
    proc.confidence = Math.min(
      1,
      proc.confidence + 0.05
    );

    this.persist();
    return proc;
  }

  /**
   * Record failed execution.
   */
  recordFailure(
    id: string,
    executionTimeMs: number,
    failureMode?: string
  ): ProceduralMemory | null {
    const proc = this.memories.get(id);
    if (!proc) return null;

    proc.statistics.timesExecuted++;
    proc.statistics.failureCount++;
    proc.statistics.averageDuration =
      (proc.statistics.averageDuration *
        (proc.statistics.timesExecuted - 1) +
        executionTimeMs) /
      proc.statistics.timesExecuted;
    proc.statistics.successRate =
      proc.statistics.successCount / proc.statistics.timesExecuted;
    proc.lastExecuted = Date.now();
    proc.confidence = Math.max(
      0,
      proc.confidence - 0.1
    );

    if (
      failureMode &&
      !proc.knownFailureModes?.includes(failureMode)
    ) {
      if (!proc.knownFailureModes) proc.knownFailureModes = [];
      proc.knownFailureModes.push(failureMode);
    }

    this.persist();
    return proc;
  }

  /**
   * Get procedures with high success rate.
   */
  getReliable(minSuccessRate: number = 0.8): ProceduralMemory[] {
    return Array.from(this.memories.values())
      .filter(
        (p) =>
          p.statistics.timesExecuted >= 2 &&
          p.statistics.successRate >= minSuccessRate
      )
      .sort((a, b) => b.statistics.successRate - a.statistics.successRate);
  }

  /**
   * Get procedures that need improvement.
   */
  getNeedingImprovement(maxSuccessRate: number = 0.6): ProceduralMemory[] {
    return Array.from(this.memories.values())
      .filter(
        (p) =>
          p.statistics.timesExecuted >= 3 &&
          p.statistics.successRate <= maxSuccessRate
      )
      .sort((a, b) => a.statistics.successRate - b.statistics.successRate);
  }

  /**
   * Get procedures by confidence.
   */
  getByConfidence(minConfidence: number = 0.5): ProceduralMemory[] {
    return Array.from(this.memories.values())
      .filter((p) => p.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get recently used procedures.
   */
  getRecent(limit: number = 5): ProceduralMemory[] {
    return Array.from(this.memories.values())
      .filter((p) => p.lastExecuted)
      .sort((a, b) => (b.lastExecuted || 0) - (a.lastExecuted || 0))
      .slice(0, limit);
  }

  /**
   * Get related procedures (by tools or categories).
   */
  getRelated(id: string, limit: number = 5): ProceduralMemory[] {
    const proc = this.memories.get(id);
    if (!proc) return [];

    const toolSet = new Set(proc.requiredTools);
    const scored = Array.from(this.memories.values())
      .filter((p) => p.id !== id)
      .map((p) => {
        let score = 0;
        const intersection = p.requiredTools.filter((t) =>
          toolSet.has(t)
        ).length;
        score += intersection * 2;
        if (p.category === proc.category) score += 3;
        return { proc: p, score };
      })
      .filter(({ score }) => score > 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ proc: p }) => p);
  }

  /**
   * Delete a procedure.
   */
  delete(id: string): boolean {
    const proc = this.memories.get(id);
    if (!proc) return false;

    this.indexByCategory.get(proc.category)?.delete(id);
    this.memories.delete(id);
    this.persist();
    return true;
  }

  /**
   * Get total count.
   */
  count(): number {
    return this.memories.size;
  }

  /**
   * Get statistics.
   */
  getStatistics(): {
    total: number;
    byCategory: Record<string, number>;
    averageSuccessRate: number;
    averageConfidence: number;
    totalExecutions: number;
    totalSuccesses: number;
  } {
    const procs = Array.from(this.memories.values());
    const stats = {
      total: procs.length,
      byCategory: {} as Record<string, number>,
      averageSuccessRate: 0,
      averageConfidence: 0,
      totalExecutions: 0,
      totalSuccesses: 0,
    };

    let totalSuccess = 0;
    let totalConfidence = 0;

    for (const proc of procs) {
      stats.byCategory[proc.category] =
        (stats.byCategory[proc.category] || 0) + 1;
      stats.totalExecutions +=
        proc.statistics.timesExecuted;
      stats.totalSuccesses +=
        proc.statistics.successCount;
      totalSuccess += proc.statistics.successRate;
      totalConfidence += proc.confidence;
    }

    if (procs.length > 0) {
      stats.averageSuccessRate = totalSuccess / procs.length;
      stats.averageConfidence =
        totalConfidence / procs.length;
    }

    return stats;
  }

  /**
   * Clear all (testing).
   */
  clear(): void {
    this.memories.clear();
    this.indexByCategory.clear();
    this.persist();
  }

  /**
   * Persist to disk.
   */
  private persist(): void {
    try {
      const data = Array.from(this.memories.values());
      const dir = path.dirname(PROCEDURAL_MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        PROCEDURAL_MEMORY_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error(
        "[ProceduralMemory] Failed to persist:",
        error
      );
    }
  }

  /**
   * Load from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(PROCEDURAL_MEMORY_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(PROCEDURAL_MEMORY_FILE, "utf-8")
        );
        if (Array.isArray(data)) {
          this.memories.clear();
          this.indexByCategory.clear();

          data.forEach((proc) => {
            this.memories.set(proc.id, proc);
            const catIds = this.indexByCategory.get(
              proc.category
            ) || new Set();
            catIds.add(proc.id);
            this.indexByCategory.set(proc.category, catIds);
          });

          console.debug(
            `[ProceduralMemory] Loaded ${this.memories.size} procedures`
          );
        }
      }
    } catch (error) {
      console.error(
        "[ProceduralMemory] Failed to load:",
        error
      );
    }
  }

  /**
   * Generate unique ID.
   */
  private generateId(): string {
    return `proc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let proceduralEngine: ProceduralMemoryEngine | null = null;

export function getProceduralMemory(): ProceduralMemoryEngine {
  if (!proceduralEngine) {
    proceduralEngine = new ProceduralMemoryEngine();
  }
  return proceduralEngine;
}
