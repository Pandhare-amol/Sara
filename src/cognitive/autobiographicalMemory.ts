/**
 * Autobiographical Memory System
 *
 * Stores important milestones, projects, goals, relationships, and events
 * that give SARA continuity across sessions.
 * Tracks what SARA has done, learned, and accomplished over time.
 */

import fs from "fs";
import path from "path";
import { dataFile } from "../../server_paths";
import { AutobiographicalMemory } from "./types";

const AUTOBIOGRAPHICAL_MEMORY_FILE = dataFile("autobiographical_memories.json");

export class AutobiographicalMemoryEngine {
  private memories: Map<string, AutobiographicalMemory> = new Map();
  private indexByType: Map<string, Set<string>> = new Map();
  private indexByProject: Map<string, Set<string>> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Record an important event or milestone.
   */
  record(
    type: AutobiographicalMemory["type"],
    content: string,
    options: {
      significance?: number; // 1-10
      project?: string;
      tags?: string[];
      relatedEpisodes?: string[];
      relatedSemantic?: string[];
      metadata?: Record<string, unknown>;
    } = {}
  ): AutobiographicalMemory {
    const mem: AutobiographicalMemory = {
      id: this.generateId(),
      type,
      timestamp: Date.now(),
      content,
      significance: options.significance ?? 5,
      relatedEpisodes: options.relatedEpisodes,
      relatedSemantic: options.relatedSemantic,
      project: options.project,
      tags: options.tags,
      metadata: options.metadata || {},
    };

    this.memories.set(mem.id, mem);

    // Index by type
    const typeIds = this.indexByType.get(type) || new Set();
    typeIds.add(mem.id);
    this.indexByType.set(type, typeIds);

    // Index by project if present
    if (options.project) {
      const projIds = this.indexByProject.get(
        options.project
      ) || new Set();
      projIds.add(mem.id);
      this.indexByProject.set(options.project, projIds);
    }

    this.persist();
    return mem;
  }

  /**
   * Get a memory by ID.
   */
  get(id: string): AutobiographicalMemory | null {
    return this.memories.get(id) || null;
  }

  /**
   * Get all memories (newest first).
   */
  list(limit?: number): AutobiographicalMemory[] {
    const sorted = Array.from(this.memories.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Get memories of a specific type.
   */
  getByType(
    type: AutobiographicalMemory["type"],
    limit?: number
  ): AutobiographicalMemory[] {
    const ids = this.indexByType.get(type) || new Set();
    const mems = Array.from(ids)
      .map((id) => this.memories.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp);
    return limit ? mems.slice(0, limit) : mems;
  }

  /**
   * Get memories related to a project.
   */
  getByProject(project: string): AutobiographicalMemory[] {
    const ids = this.indexByProject.get(project) || new Set();
    return Array.from(ids)
      .map((id) => this.memories.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Search by content or tags.
   */
  search(query: string, limit: number = 10): AutobiographicalMemory[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.memories.values())
      .map((mem) => {
        let score = 0;
        if (mem.content.toLowerCase().includes(q)) {
          const words = q.split(/\s+/);
          const matches = words.filter((w) =>
            mem.content.toLowerCase().includes(w)
          ).length;
          score = matches;
        }
        if (mem.tags?.some((t) => t.toLowerCase().includes(q))) {
          score += 3;
        }
        score *= mem.significance / 10;
        return { mem, score };
      })
      .filter(({ score }) => score > 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ mem }) => mem);
  }

  /**
   * Get milestones (highest significance items).
   */
  getMilestones(limit: number = 20): AutobiographicalMemory[] {
    return Array.from(this.memories.values())
      .sort((a, b) => {
        // Sort by significance, then recency
        const sigDiff = b.significance - a.significance;
        if (sigDiff !== 0) return sigDiff;
        return b.timestamp - a.timestamp;
      })
      .slice(0, limit);
  }

  /**
   * Get memories within time range.
   */
  getByTimeRange(
    startTime: number,
    endTime: number
  ): AutobiographicalMemory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.timestamp >= startTime && m.timestamp <= endTime)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get recent memories (last N days).
   */
  getRecent(days: number = 7): AutobiographicalMemory[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.getByTimeRange(since, Date.now());
  }

  /**
   * Get active projects.
   */
  getActiveProjects(): string[] {
    const projects = new Set<string>();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const mem of this.memories.values()) {
      if (
        mem.project &&
        mem.timestamp >= thirtyDaysAgo
      ) {
        projects.add(mem.project);
      }
    }

    return Array.from(projects);
  }

  /**
   * Get project summary (project milestones and key events).
   */
  getProjectSummary(project: string): {
    project: string;
    startDate: number;
    lastUpdate: number;
    milestones: AutobiographicalMemory[];
    goalCount: number;
    eventCount: number;
    totalSignificance: number;
  } {
    const mems = this.getByProject(project);
    const sorted = mems.sort(
      (a, b) => a.timestamp - b.timestamp
    );

    return {
      project,
      startDate: sorted[0]?.timestamp || Date.now(),
      lastUpdate: sorted[sorted.length - 1]?.timestamp || Date.now(),
      milestones: mems.filter((m) => m.significance >= 8),
      goalCount: mems.filter((m) => m.type === "goal").length,
      eventCount: mems.filter((m) => m.type === "event").length,
      totalSignificance: mems.reduce(
        (sum, m) => sum + m.significance,
        0
      ),
    };
  }

  /**
   * Get relationship information.
   */
  getRelationships(): AutobiographicalMemory[] {
    return this.getByType("relationship");
  }

  /**
   * Get important instructions from user.
   */
  getImportantInstructions(): AutobiographicalMemory[] {
    return Array.from(this.memories.values())
      .filter(
        (m) =>
          m.type === "instruction" &&
          m.significance >= 6
      )
      .sort((a, b) => {
        const sigDiff = b.significance - a.significance;
        if (sigDiff !== 0) return sigDiff;
        return b.timestamp - a.timestamp;
      });
  }

  /**
   * Get long-term goals.
   */
  getGoals(): AutobiographicalMemory[] {
    return this.getByType("goal");
  }

  /**
   * Get events/experiences.
   */
  getEvents(): AutobiographicalMemory[] {
    return this.getByType("event");
  }

  /**
   * Answer "What did we work on [time period]?"
   */
  workSummary(days: number = 1): string {
    const recent = this.getRecent(days);
    if (recent.length === 0) {
      return "I don't have any recorded activities in that timeframe.";
    }

    const grouped = new Map<string, number>();
    for (const mem of recent) {
      if (mem.project) {
        grouped.set(
          mem.project,
          (grouped.get(mem.project) || 0) + 1
        );
      }
    }

    const projects = Array.from(grouped.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([proj]) => proj)
      .slice(0, 3);

    return (
      `Over the last ${days} day(s), we worked on: ` +
      projects.join(", ")
    );
  }

  /**
   * Delete a memory.
   */
  delete(id: string): boolean {
    const mem = this.memories.get(id);
    if (!mem) return false;

    this.indexByType.get(mem.type)?.delete(id);
    if (mem.project) {
      this.indexByProject.get(mem.project)?.delete(id);
    }

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
    byType: Record<string, number>;
    projectCount: number;
    averageSignificance: number;
    timeSpan: number; // days
  } {
    const mems = Array.from(this.memories.values());
    const stats = {
      total: mems.length,
      byType: {} as Record<string, number>,
      projectCount: new Set(
        mems.map((m) => m.project).filter(Boolean)
      ).size,
      averageSignificance: 0,
      timeSpan: 0,
    };

    let totalSig = 0;
    for (const mem of mems) {
      stats.byType[mem.type] =
        (stats.byType[mem.type] || 0) + 1;
      totalSig += mem.significance;
    }

    if (mems.length > 0) {
      stats.averageSignificance = totalSig / mems.length;
      const sorted = mems.sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const timeSpanMs =
        sorted[mems.length - 1].timestamp -
        sorted[0].timestamp;
      stats.timeSpan = Math.ceil(
        timeSpanMs / (24 * 60 * 60 * 1000)
      );
    }

    return stats;
  }

  /**
   * Clear all (testing).
   */
  clear(): void {
    this.memories.clear();
    this.indexByType.clear();
    this.indexByProject.clear();
    this.persist();
  }

  /**
   * Persist to disk.
   */
  private persist(): void {
    try {
      const data = Array.from(this.memories.values());
      const dir = path.dirname(
        AUTOBIOGRAPHICAL_MEMORY_FILE
      );
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        AUTOBIOGRAPHICAL_MEMORY_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error(
        "[AutobiographicalMemory] Failed to persist:",
        error
      );
    }
  }

  /**
   * Load from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(AUTOBIOGRAPHICAL_MEMORY_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(
            AUTOBIOGRAPHICAL_MEMORY_FILE,
            "utf-8"
          )
        );
        if (Array.isArray(data)) {
          this.memories.clear();
          this.indexByType.clear();
          this.indexByProject.clear();

          data.forEach((mem) => {
            this.memories.set(mem.id, mem);

            const typeIds = this.indexByType.get(mem.type) ||
              new Set();
            typeIds.add(mem.id);
            this.indexByType.set(mem.type, typeIds);

            if (mem.project) {
              const projIds = this.indexByProject.get(
                mem.project
              ) || new Set();
              projIds.add(mem.id);
              this.indexByProject.set(
                mem.project,
                projIds
              );
            }
          });

          console.debug(
            `[AutobiographicalMemory] Loaded ${this.memories.size} autobiographical memories`
          );
        }
      }
    } catch (error) {
      console.error(
        "[AutobiographicalMemory] Failed to load:",
        error
      );
    }
  }

  /**
   * Generate unique ID.
   */
  private generateId(): string {
    return `ab-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let autobiographicalEngine: AutobiographicalMemoryEngine | null = null;

export function getAutobiographicalMemory(): AutobiographicalMemoryEngine {
  if (!autobiographicalEngine) {
    autobiographicalEngine = new AutobiographicalMemoryEngine();
  }
  return autobiographicalEngine;
}
