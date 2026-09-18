/**
 * Cognitive Orchestrator
 *
 * Central coordination hub for all cognitive systems.
 * Manages memory retrieval, context building, planning, and learning.
 * Integrates with RAG, desktop agent, and task execution.
 */

import { getWorkingMemory } from "./workingMemory";
import { getEpisodicMemory } from "./episodicMemory";
import { getSemanticMemory } from "./semanticMemory";
import { getProceduralMemory } from "./proceduralMemory";
import { getAutobiographicalMemory } from "./autobiographicalMemory";
import { getMemoryConsolidator } from "./memoryConsolidator";
import { getRelationshipContextManager } from "../services/RelationshipContextManager";
import { getDigitalWorldContext } from "./digitalWorldContext";
import {
  CognitiveContext,
  MemoryRetrievalContext,
  MemoryRetrievalResult,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  AutobiographicalMemory,
} from "./types";

export class CognitiveOrchestrator {
  private working = getWorkingMemory();
  private episodic = getEpisodicMemory();
  private semantic = getSemanticMemory();
  private procedural = getProceduralMemory();
  private autobiographical = getAutobiographicalMemory();
  private consolidator = getMemoryConsolidator();
  private digitalWorld = getDigitalWorldContext();

  /**
   * Build complete cognitive context for decision-making.
   * Assembles working memory, relevant long-term memories, and observations.
   */
  async buildContext(options: {
    goal?: string;
    taskType?: string;
    projectContext?: string;
    includeRAG?: boolean;
    ragQuery?: string;
    maxMemories?: number;
  } = {}): Promise<CognitiveContext> {
    const startTime = Date.now();

    // 1. Get working memory summary (highest priority)
    const workingMemorySummary = this.working.summary();

    // 2. Retrieve relevant memories
    const memories = await this.retrieveMemories({
      query: options.goal || options.taskType || "",
      intent: options.taskType,
      projectContext: options.projectContext,
      limit: options.maxMemories ?? 20,
      scoreThreshold: 0.5,
    });
    const relationshipContext = await getRelationshipContextManager()
      .resolveTurnContext(options.goal || "")
      .catch(() => null);

    // 3. Get recent actions from episodic memory
    const recentEpisodes = this.episodic.list(5);
    const recentActions = recentEpisodes
      .flatMap((ep) => ep.execution.actions)
      .slice(0, 10);

    // 4. Assemble context
    const context: CognitiveContext = {
      workingMemory: workingMemorySummary,
      relevantMemories: memories,
      currentGoal: options.goal,
      recentActions,
      projectContext: options.projectContext,
      digitalWorld: this.digitalWorld.getSnapshot(),
      relationshipContext,
      timeOfDay: Date.now(),
    };

    console.debug(
      `[CognitiveOrchestrator] Built context in ${Date.now() - startTime}ms`
    );
    return context;
  }

  /**
   * Retrieve memories relevant to current task using hybrid search.
   */
  async retrieveMemories(
    options: MemoryRetrievalContext
  ): Promise<MemoryRetrievalResult> {
    const startTime = Date.now();
    const result: MemoryRetrievalResult = {
      episodic: [],
      semantic: [],
      procedural: [],
      autobiographical: [],
      confidence: 0.5,
    };

    // 1. Search episodic memory (past experiences)
    result.episodic = this.episodic.search(
      options.query,
      Math.ceil(options.limit * 0.4)
    );

    // 2. Search semantic memory (knowledge)
    result.semantic = this.semantic.search(
      options.query,
      Math.ceil(options.limit * 0.3)
    );

    // 3. Search procedural memory (skills/procedures)
    result.procedural = this.procedural.search(
      options.query,
      Math.ceil(options.limit * 0.2)
    );

    // 4. Search autobiographical memory (important milestones)
    if (options.projectContext) {
      result.autobiographical = this.autobiographical.getByProject(
        options.projectContext
      );
    } else {
      result.autobiographical = this.autobiographical.getMilestones(5);
    }

    // 5. Calculate confidence based on matches
    const totalMatches =
      result.episodic.length +
      result.semantic.length +
      result.procedural.length +
      result.autobiographical.length;
    result.confidence = Math.min(
      1,
      Math.max(
        0.3,
        totalMatches / (options.limit || 10)
      )
    );

    // Record memory references for learning
    for (const sem of result.semantic) {
      this.semantic.recordReference(sem.id);
    }

    console.debug(
      `[CognitiveOrchestrator] Retrieved memories in ${Date.now() - startTime}ms: ` +
        `${result.episodic.length} episodic, ${result.semantic.length} semantic, ` +
        `${result.procedural.length} procedural`
    );

    return result;
  }

  /**
   * Record a new task experience in episodic memory.
   */
  recordEpisode(episode: Omit<EpisodicMemory, "id" | "timestamp">) {
    return this.episodic.record(episode);
  }

  /**
   * Remember a semantic fact, preference, or rule.
   */
  rememberFact(
    category: string,
    content: string,
    type: "preference" | "fact" | "concept" | "rule" | "relationship",
    options?: {
      source?: string;
      confidence?: number;
      metadata?: Record<string, unknown>;
    }
  ) {
    return this.semantic.remember(
      category,
      content,
      type,
      options
    );
  }

  /**
   * Save a skill or procedure.
   */
  saveSkill(procedure: Omit<ProceduralMemory, "id" | "lastExecuted">) {
    return this.procedural.save(procedure);
  }

  /**
   * Get best matching skills for a goal.
   */
  getBestSkills(goal: string, limit: number = 5): ProceduralMemory[] {
    const matches = this.procedural.search(goal, limit);
    return matches.filter((p) => p.statistics.successRate >= 0.5);
  }

  /**
   * Record successful skill execution.
   */
  recordSkillSuccess(skillId: string, durationMs: number) {
    return this.procedural.recordSuccess(skillId, durationMs);
  }

  /**
   * Record failed skill execution.
   */
  recordSkillFailure(
    skillId: string,
    durationMs: number,
    failureMode?: string
  ) {
    return this.procedural.recordFailure(
      skillId,
      durationMs,
      failureMode
    );
  }

  /**
   * Record autobiographical milestone.
   */
  recordMilestone(
    type:
      | "milestone"
      | "project"
      | "instruction"
      | "relationship"
      | "goal"
      | "event",
    content: string,
    options?: {
      significance?: number;
      project?: string;
      tags?: string[];
      relatedEpisodes?: string[];
      metadata?: Record<string, unknown>;
    }
  ) {
    return this.autobiographical.record(type, content, options);
  }

  /**
   * Get work summary for a time period.
   */
  getWorkSummary(days: number = 1): string {
    return this.autobiographical.workSummary(days);
  }

  /**
   * Add something to working memory for the current task.
   */
  setWorking(
    key: string,
    value: unknown,
    options?: {
      source?: string;
      ttl?: number;
      priority?: number;
    }
  ): boolean {
    return this.working.set(key, value, options);
  }

  /**
   * Get from working memory.
   */
  getWorking(key: string): unknown {
    return this.working.get(key);
  }

  /**
   * Clear working memory (end of task).
   */
  clearWorking(): void {
    this.working.clear();
  }

  /**
   * Get memory statistics for diagnostics.
   */
  getMemoryStats() {
    return {
      working: {
        items: this.working.all().length,
      },
      episodic: this.episodic.getStatistics(),
      semantic: this.semantic.getStatistics(),
      procedural: this.procedural.getStatistics(),
      autobiographical: this.autobiographical.getStatistics(),
      lastConsolidation: new Date(
        this.consolidator.getLastConsolidation()
      ),
    };
  }

  /**
   * Manually trigger memory consolidation.
   */
  async consolidateMemories() {
    return this.consolidator.consolidate();
  }

  /**
   * Get answer to "What did we learn from this?"
   */
  getLessons(episodeId: string): string[] {
    const ep = this.episodic.get(episodeId);
    if (!ep) return [];
    return ep.lesson.keyInsights || [];
  }

  /**
   * Find similar past episodes to current goal.
   */
  getSimilarPastEpisodes(goal: string, limit: number = 3): EpisodicMemory[] {
    return this.episodic.search(goal, limit);
  }

  /**
   * Update working memory priority based on importance.
   */
  updateMemoryPriority(key: string, priority: number): void {
    this.working.setPriority(key, priority);
  }

  /**
   * Get user preferences.
   */
  getUserPreferences(): SemanticMemory[] {
    return this.semantic.getPreferences();
  }

  /**
   * Check for contradictions in knowledge.
   */
  getKnowledgeContradictions(): Array<{
    memory1: SemanticMemory;
    memory2: SemanticMemory;
  }> {
    const prefs = this.semantic.getPreferences();
    const contradictions: Array<{
      memory1: SemanticMemory;
      memory2: SemanticMemory;
    }> = [];

    for (const pref of prefs) {
      if (pref.contradictions) {
        for (const cid of pref.contradictions) {
          const other = this.semantic.get(cid);
          if (other) {
            contradictions.push({
              memory1: pref,
              memory2: other,
            });
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * Get active projects.
   */
  getActiveProjects(): string[] {
    return this.autobiographical.getActiveProjects();
  }

  /**
   * Get project context and history.
   */
  getProjectContext(project: string) {
    return this.autobiographical.getProjectSummary(project);
  }

  /**
   * Shutdown gracefully.
   */
  shutdown(): void {
    this.working.shutdown();
    this.consolidator.shutdown();
    console.debug("[CognitiveOrchestrator] Shutdown complete");
  }
}

// Singleton
let orchestrator: CognitiveOrchestrator | null = null;

export function getCognitiveOrchestrator(): CognitiveOrchestrator {
  if (!orchestrator) {
    orchestrator = new CognitiveOrchestrator();
  }
  return orchestrator;
}

export function resetCognitiveOrchestrator(): void {
  if (orchestrator) {
    orchestrator.shutdown();
  }
  orchestrator = new CognitiveOrchestrator();
}
