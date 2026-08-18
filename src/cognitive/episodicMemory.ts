/**
 * Episodic Memory System
 *
 * Stores structured experiences: tasks, goals, actions, outcomes, and lessons.
 * Each episode is a complete record of a task execution.
 * Persisted to database for cross-session continuity.
 */

import fs from "fs";
import path from "path";
import { dataFile } from "../../server_paths";
import { EpisodicMemory } from "./types";

const EPISODIC_MEMORY_FILE = dataFile("episodic_memories.json");
const EPISODIC_DB_TABLE = "episodic_memory_v2"; // Versioned table name

export class EpisodicMemoryEngine {
  private memories: Map<string, EpisodicMemory> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Record a new episode.
   */
  record(episode: Omit<EpisodicMemory, "id" | "timestamp">): EpisodicMemory {
    const fullEpisode: EpisodicMemory = {
      id: this.generateId(),
      timestamp: Date.now(),
      ...episode,
    };

    this.memories.set(fullEpisode.id, fullEpisode);
    this.persist();

    console.debug(`[EpisodicMemory] Recorded episode: ${fullEpisode.title} (${fullEpisode.id})`);
    return fullEpisode;
  }

  /**
   * Update an existing episode.
   */
  update(id: string, updates: Partial<EpisodicMemory>): EpisodicMemory | null {
    const episode = this.memories.get(id);
    if (!episode) return null;

    const updated = { ...episode, ...updates, id, timestamp: episode.timestamp };
    this.memories.set(id, updated);
    this.persist();

    return updated;
  }

  /**
   * Get an episode by ID.
   */
  get(id: string): EpisodicMemory | null {
    return this.memories.get(id) || null;
  }

  /**
   * List all episodes (newest first).
   */
  list(limit?: number): EpisodicMemory[] {
    const sorted = Array.from(this.memories.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Search episodes by title, task, or content.
   */
  search(query: string, limit: number = 10): EpisodicMemory[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.memories.values()).map((ep) => {
      let score = 0;
      if (ep.title.toLowerCase().includes(q)) score += 3;
      if (ep.taskId?.toLowerCase().includes(q)) score += 2;
      if (ep.context.goal.toLowerCase().includes(q)) score += 2;
      if (
        ep.lesson.keyInsights?.some((s) =>
          s.toLowerCase().includes(q)
        )
      )
        score += 1;
      return { ep, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ ep }) => ep);
  }

  /**
   * Get episodes by task or conversation.
   */
  getByTaskId(taskId: string): EpisodicMemory[] {
    return Array.from(this.memories.values())
      .filter((ep) => ep.taskId === taskId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getByConversationId(conversationId: string): EpisodicMemory[] {
    return Array.from(this.memories.values())
      .filter((ep) => ep.conversationId === conversationId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get episodes by importance.
   */
  getByImportance(minImportance: number, limit?: number): EpisodicMemory[] {
    const filtered = Array.from(this.memories.values())
      .filter((ep) => ep.metadata.importance >= minImportance)
      .sort((a, b) => {
        // Sort by importance, then recency
        const importanceDiff =
          b.metadata.importance - a.metadata.importance;
        if (importanceDiff !== 0) return importanceDiff;
        return b.timestamp - a.timestamp;
      });

    return limit ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Get recent successful episodes.
   */
  getSuccessful(limit: number = 10): EpisodicMemory[] {
    return Array.from(this.memories.values())
      .filter(
        (ep) =>
          ep.outcome.success &&
          ep.outcome.goalAchieved
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get recent failed episodes for learning.
   */
  getFailed(limit: number = 5): EpisodicMemory[] {
    return Array.from(this.memories.values())
      .filter(
        (ep) =>
          !ep.outcome.success ||
          !ep.outcome.goalAchieved
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get episodes related to a specific context (project, application, etc).
   */
  getByContext(contextKey: string, contextValue: string): EpisodicMemory[] {
    return Array.from(this.memories.values())
      .filter((ep) => {
        if (
          contextKey === "application" &&
          ep.context.applications?.includes(contextValue)
        )
          return true;
        if (
          contextKey === "file" &&
          ep.context.files?.includes(contextValue)
        )
          return true;
        if (contextKey === "goal" && ep.context.goal.includes(contextValue))
          return true;
        return false;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get episodes with specific lessons or failure modes.
   */
  getWithLesson(lessonKeyword: string): EpisodicMemory[] {
    const q = lessonKeyword.toLowerCase();
    return Array.from(this.memories.values())
      .filter(
        (ep) =>
          ep.lesson.keyInsights?.some((s) =>
            s.toLowerCase().includes(q)
          ) ||
          ep.lesson.failureModes?.some((f) =>
            f.toLowerCase().includes(q)
          ) ||
          ep.lesson.successFactors?.some((s) =>
            s.toLowerCase().includes(q)
          )
      )
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get the total count.
   */
  count(): number {
    return this.memories.size;
  }

  /**
   * Get statistics about episodes.
   */
  getStatistics(): {
    total: number;
    successRate: number;
    averageExecutionTime: number;
    averageImportance: number;
    averageConfidence: number;
    mostCommonFailureModes: string[];
    mostCommonLessons: string[];
  } {
    const episodes = Array.from(this.memories.values());
    if (episodes.length === 0) {
      return {
        total: 0,
        successRate: 0,
        averageExecutionTime: 0,
        averageImportance: 0,
        averageConfidence: 0,
        mostCommonFailureModes: [],
        mostCommonLessons: [],
      };
    }

    const successful = episodes.filter((ep) => ep.outcome.success).length;
    const totalTime = episodes.reduce(
      (sum, ep) => sum + ep.outcome.completionTime,
      0
    );
    const avgImportance =
      episodes.reduce(
        (sum, ep) => sum + ep.metadata.importance,
        0
      ) / episodes.length;
    const avgConfidence =
      episodes.reduce(
        (sum, ep) => sum + ep.metadata.confidence,
        0
      ) / episodes.length;

    // Find most common failure modes
    const failureModes: Record<string, number> = {};
    episodes.forEach((ep) => {
      ep.lesson.failureModes?.forEach((mode) => {
        failureModes[mode] = (failureModes[mode] || 0) + 1;
      });
    });
    const topFailureModes = Object.entries(failureModes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([mode]) => mode);

    // Find most common lessons
    const lessons: Record<string, number> = {};
    episodes.forEach((ep) => {
      ep.lesson.keyInsights?.forEach((lesson) => {
        lessons[lesson] = (lessons[lesson] || 0) + 1;
      });
    });
    const topLessons = Object.entries(lessons)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([lesson]) => lesson);

    return {
      total: episodes.length,
      successRate: successful / episodes.length,
      averageExecutionTime: totalTime / episodes.length,
      averageImportance: avgImportance,
      averageConfidence: avgConfidence,
      mostCommonFailureModes: topFailureModes,
      mostCommonLessons: topLessons,
    };
  }

  /**
   * Delete an episode.
   */
  delete(id: string): boolean {
    const deleted = this.memories.delete(id);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  /**
   * Clear all episodes (for testing).
   */
  clear(): void {
    this.memories.clear();
    this.persist();
  }

  /**
   * Persist to disk.
   */
  private persist(): void {
    try {
      const data = Array.from(this.memories.values());
      const dir = path.dirname(EPISODIC_MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        EPISODIC_MEMORY_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error(
        "[EpisodicMemory] Failed to persist:",
        error
      );
    }
  }

  /**
   * Load from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(EPISODIC_MEMORY_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(EPISODIC_MEMORY_FILE, "utf-8")
        );
        if (Array.isArray(data)) {
          this.memories.clear();
          data.forEach((ep) => {
            this.memories.set(ep.id, ep);
          });
          console.debug(
            `[EpisodicMemory] Loaded ${this.memories.size} episodes`
          );
        }
      }
    } catch (error) {
      console.error(
        "[EpisodicMemory] Failed to load:",
        error
      );
    }
  }

  /**
   * Generate unique ID.
   */
  private generateId(): string {
    return `ep-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let episodicEngine: EpisodicMemoryEngine | null = null;

export function getEpisodicMemory(): EpisodicMemoryEngine {
  if (!episodicEngine) {
    episodicEngine = new EpisodicMemoryEngine();
  }
  return episodicEngine;
}
