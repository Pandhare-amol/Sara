/**
 * Memory Management Service
 * Manages episodic, semantic, procedural, preference, failure, achievement, and autobiographical memories
 */

import type {
  MemoryRecord,
  MemoryType,
  MemoryStore,
  MemoryQuery,
  MemoryRetrievalResult,
  MemoryOperationResult,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  PreferenceMemory,
  FailureMemory,
  AchievementMemory,
  AutobiographicalMemory,
} from '../types/Memory';
import {
  createMemoryStore,
  createEpisodicMemory,
  createSemanticMemory,
  createPreferenceMemory,
  createFailureMemory,
  createAchievementMemory,
  createAutobiographicalMemory,
} from '../types/Memory';

export class MemoryService {
  private store: MemoryStore;
  private retrievalCache: Map<string, MemoryRetrievalResult> = new Map();
  private maxCacheAge: number = 60000; // 1 minute

  constructor() {
    this.store = createMemoryStore();
  }

  /**
   * Store episodic memory
   */
  storeEpisodic(memory: EpisodicMemory): MemoryOperationResult {
    try {
      this.store.episodic.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store semantic memory
   */
  storeSemantic(memory: SemanticMemory): MemoryOperationResult {
    try {
      this.store.semantic.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store procedural memory (skills)
   */
  storeProcedural(memory: ProceduralMemory): MemoryOperationResult {
    try {
      this.store.procedural.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store preference memory
   */
  storePreference(memory: PreferenceMemory): MemoryOperationResult {
    try {
      // Check if preference already exists for this key
      const existing = Array.from(this.store.preference.values()).find(
        (p) => p.preference.key === memory.preference.key && p.preference.category === memory.preference.category
      );

      if (existing) {
        this.store.preference.delete(existing.id);
      }

      this.store.preference.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store failure memory
   */
  storeFailure(memory: FailureMemory): MemoryOperationResult {
    try {
      this.store.failure.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store achievement memory
   */
  storeAchievement(memory: AchievementMemory): MemoryOperationResult {
    try {
      this.store.achievement.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Store autobiographical memory
   */
  storeAutobiographical(memory: AutobiographicalMemory): MemoryOperationResult {
    try {
      this.store.autobiographical.set(memory.id, memory);
      this.invalidateCache();
      return { success: true, memoryId: memory.id };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Query memories
   */
  queryMemories(query: MemoryQuery): MemoryRetrievalResult {
    const startTime = Date.now();

    // Get candidate memories based on type
    let candidates: MemoryRecord[] = [];

    if (!query.type || query.type === 'episodic') {
      candidates.push(...Array.from(this.store.episodic.values()));
    }
    if (!query.type || query.type === 'semantic') {
      candidates.push(...Array.from(this.store.semantic.values()));
    }
    if (!query.type || query.type === 'procedural') {
      candidates.push(...Array.from(this.store.procedural.values()));
    }
    if (!query.type || query.type === 'preference') {
      candidates.push(...Array.from(this.store.preference.values()));
    }
    if (!query.type || query.type === 'failure') {
      candidates.push(...Array.from(this.store.failure.values()));
    }
    if (!query.type || query.type === 'achievement') {
      candidates.push(...Array.from(this.store.achievement.values()));
    }
    if (!query.type || query.type === 'autobiographical') {
      candidates.push(...Array.from(this.store.autobiographical.values()));
    }

    // Filter by confidence
    if (query.confidence !== undefined) {
      candidates = candidates.filter((m) => m.confidence >= query.confidence!);
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter((m) =>
        query.tags!.some((tag) => m.tags.includes(tag))
      );
    }

    // Exclude tags
    if (query.excludeTags && query.excludeTags.length > 0) {
      candidates = candidates.filter((m) =>
        !query.excludeTags!.some((tag) => m.tags.includes(tag))
      );
    }

    // Filter by recency
    if (query.recency !== undefined) {
      const cutoff = Date.now() - query.recency;
      candidates = candidates.filter((m) => m.timestamp >= cutoff);
    }

    // Sort by relevance (recency + confidence)
    const relevanceScores = new Map<string, number>();
    for (const memory of candidates) {
      const ageFactor = Math.max(0, 1 - (Date.now() - memory.timestamp) / 86400000); // decay over 1 day
      const relevance = memory.confidence * (0.7 + 0.3 * ageFactor);
      relevanceScores.set(memory.id, relevance);
    }

    candidates.sort((a, b) => (relevanceScores.get(b.id) || 0) - (relevanceScores.get(a.id) || 0));

    // Limit results
    const limit = query.limit || 10;
    const results = candidates.slice(0, limit);

    const result: MemoryRetrievalResult = {
      memories: results,
      relevanceScores,
      queryTime: Date.now() - startTime,
      totalMatches: candidates.length,
    };

    return result;
  }

  /**
   * Retrieve similar memories
   */
  retrieveSimilar(memory: MemoryRecord, maxResults: number = 5): MemoryRecord[] {
    const result = this.queryMemories({
      type: memory.type,
      tags: memory.tags,
      confidence: memory.confidence * 0.8,
      limit: maxResults,
    });

    return result.memories.filter((m) => m.id !== memory.id);
  }

  /**
   * Retrieve memories relevant to a task
   */
  retrieveForTask(
    taskType: string,
    context: Record<string, any> = {}
  ): {
    failures: FailureMemory[];
    achievements: AchievementMemory[];
    skills: ProceduralMemory[];
    preferences: PreferenceMemory[];
  } {
    return {
      failures: Array.from(this.store.failure.values()).filter((f) => f.failure.taskType === taskType),
      achievements: Array.from(this.store.achievement.values()).filter((a) => a.achievement.taskType === taskType),
      skills: Array.from(this.store.procedural.values()),
      preferences: Array.from(this.store.preference.values()),
    };
  }

  /**
   * Learn from successful task
   */
  learnFromSuccess(
    taskId: string,
    taskType: string,
    goal: string,
    strategy: string,
    executionTime: number,
    attempts: number,
    verificationQuality: number
  ): AchievementMemory {
    const memory = createAchievementMemory(
      taskId,
      taskType,
      goal,
      strategy,
      executionTime,
      attempts,
      verificationQuality,
      [taskId],
      true,
      ['success', taskType]
    );

    this.storeAchievement(memory);
    return memory;
  }

  /**
   * Learn from failure
   */
  learnFromFailure(
    taskId: string,
    taskType: string,
    goal: string,
    failureType: string,
    strategy: string,
    rootCause: string,
    suggestedAlternative: string
  ): FailureMemory {
    const memory = createFailureMemory(
      taskId,
      taskType,
      goal,
      failureType,
      strategy,
      rootCause,
      suggestedAlternative,
      ['failure', taskType]
    );

    this.storeFailure(memory);

    // Check if this failure is repeated
    const similarFailures = Array.from(this.store.failure.values()).filter(
      (f) => f.failure.taskType === taskType && f.failure.failureType === failureType
    );

    if (similarFailures.length > 1) {
      memory.failure.repeated = true;
      memory.failure.repeatCount = similarFailures.length;
    }

    return memory;
  }

  /**
   * Extract reusable skill from achievement
   */
  extractSkill(memory: AchievementMemory, skillDefinition: any): ProceduralMemory | null {
    try {
      const skillMemory: ProceduralMemory = {
        id: `skill-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'procedural',
        timestamp: Date.now(),
        confidence: memory.confidence * 0.9,
        tags: ['learned', memory.achievement.taskType],
        source: 'learning',
        provenance: {
          source: 'learning',
          actor: 'sara',
          taskId: memory.achievement.taskId,
          evidence: memory.achievement.evidence,
          verified: true,
        },
        metadata: {
          learnedFromAchievementId: memory.id,
          learningTimestamp: Date.now(),
        },
        skill: skillDefinition,
      };

      this.storeProcedural(skillMemory);
      return skillMemory;
    } catch (error) {
      return null;
    }
  }

  /**
   * Update memory confidence based on evidence
   */
  updateConfidence(memoryId: string, newConfidence: number): MemoryOperationResult {
    try {
      let memory: MemoryRecord | undefined;

      // Find memory across all types
      memory =
        this.store.episodic.get(memoryId) ||
        this.store.semantic.get(memoryId) ||
        this.store.procedural.get(memoryId) ||
        this.store.preference.get(memoryId) ||
        this.store.failure.get(memoryId) ||
        this.store.achievement.get(memoryId) ||
        this.store.autobiographical.get(memoryId);

      if (!memory) {
        return {
          success: false,
          error: 'Memory not found',
        };
      }

      memory.confidence = Math.max(0, Math.min(1, newConfidence));
      this.invalidateCache();

      return { success: true, memoryId };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Delete a memory by ID across all stores.
   */
  deleteMemory(id: string): MemoryOperationResult {
    try {
      let deleted = false;
      if (this.store.episodic.delete(id)) deleted = true;
      if (this.store.semantic.delete(id)) deleted = true;
      if (this.store.procedural.delete(id)) deleted = true;
      if (this.store.preference.delete(id)) deleted = true;
      if (this.store.failure.delete(id)) deleted = true;
      if (this.store.achievement.delete(id)) deleted = true;
      if (this.store.autobiographical.delete(id)) deleted = true;
      if (!deleted) {
        return { success: false, error: 'Memory not found' };
      }
      this.invalidateCache();
      return { success: true, memoryId: id };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**

  /**
   * Decay old memories (run periodically)
   */
  decayOldMemories(): { decayed: number; removed: number } {
    const now = Date.now();
    const decayRate = 0.99; // 1% decay per day
    let decayed = 0;
    let removed = 0;

    for (const store of [
      this.store.episodic,
      this.store.semantic,
      this.store.procedural,
      this.store.preference,
      this.store.failure,
      this.store.achievement,
      this.store.autobiographical,
    ]) {
      const toRemove: string[] = [];

      for (const [id, memory] of store.entries()) {
        const ageInDays = (now - memory.timestamp) / 86400000;
        const newConfidence = memory.confidence * Math.pow(decayRate, ageInDays);

        if (newConfidence < 0.05 && memory.ttl && now - memory.timestamp > memory.ttl) {
          toRemove.push(id);
          removed++;
        } else if (newConfidence < memory.confidence) {
          memory.confidence = newConfidence;
          decayed++;
        }
      }

      for (const id of toRemove) {
        store.delete(id);
      }
    }

    this.invalidateCache();
    return { decayed, removed };
  }

  /**
   * Get memory statistics
   */
  getStatistics(): {
    total: number;
    byType: Record<MemoryType, number>;
    averageConfidence: number;
    oldestMemory: number;
    newestMemory: number;
  } {
    const allMemories = [
      ...Array.from(this.store.episodic.values()),
      ...Array.from(this.store.semantic.values()),
      ...Array.from(this.store.procedural.values()),
      ...Array.from(this.store.preference.values()),
      ...Array.from(this.store.failure.values()),
      ...Array.from(this.store.achievement.values()),
      ...Array.from(this.store.autobiographical.values()),
    ];

    const stats = {
      total: allMemories.length,
      byType: {
        episodic: this.store.episodic.size,
        semantic: this.store.semantic.size,
        procedural: this.store.procedural.size,
        preference: this.store.preference.size,
        failure: this.store.failure.size,
        achievement: this.store.achievement.size,
        autobiographical: this.store.autobiographical.size,
      } as Record<MemoryType, number>,
      averageConfidence: allMemories.length > 0
        ? allMemories.reduce((sum, m) => sum + m.confidence, 0) / allMemories.length
        : 0,
      oldestMemory: allMemories.length > 0
        ? Math.min(...allMemories.map((m) => m.timestamp))
        : Date.now(),
      newestMemory: allMemories.length > 0
        ? Math.max(...allMemories.map((m) => m.timestamp))
        : Date.now(),
    };

    return stats;
  }

  /**
   * Export memories
   */
  export(): {
    episodic: EpisodicMemory[];
    semantic: SemanticMemory[];
    procedural: ProceduralMemory[];
    preference: PreferenceMemory[];
    failure: FailureMemory[];
    achievement: AchievementMemory[];
    autobiographical: AutobiographicalMemory[];
  } {
    return {
      episodic: Array.from(this.store.episodic.values()),
      semantic: Array.from(this.store.semantic.values()),
      procedural: Array.from(this.store.procedural.values()),
      preference: Array.from(this.store.preference.values()),
      failure: Array.from(this.store.failure.values()),
      achievement: Array.from(this.store.achievement.values()),
      autobiographical: Array.from(this.store.autobiographical.values()),
    };
  }

  /**
   * Clear cache
   */
  private invalidateCache(): void {
    this.retrievalCache.clear();
  }
}

export const memoryService = new MemoryService();
