/**
 * Semantic Memory System
 *
 * Stores generalized knowledge independent from episodes:
 * user preferences, facts, concepts, rules, relationships.
 * Handles contradictions and confidence tracking.
 */

import fs from "fs";
import path from "path";
import { dataFile } from "../../server_paths";
import { SemanticMemory } from "./types";

const SEMANTIC_MEMORY_FILE = dataFile("semantic_memories.json");

export class SemanticMemoryEngine {
  private memories: Map<string, SemanticMemory> = new Map();
  private indexByCategory: Map<string, Set<string>> = new Map();
  private indexByType: Map<string, Set<string>> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Add or update a semantic memory.
   */
  remember(
    category: string,
    content: string,
    type: SemanticMemory["type"] = "fact",
    options: {
      source?: string;
      confidence?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): SemanticMemory {
    // Check for contradictions with existing memories
    const existing = this.findPotentialContradictions(
      category,
      content,
      type
    );

    const memory: SemanticMemory = {
      id: this.generateId(),
      type,
      category,
      content,
      confidence: options.confidence ?? 0.7,
      source: options.source,
      timestamp: Date.now(),
      referenceCount: 0,
      metadata: options.metadata || {},
    };

    // Mark contradictions
    if (existing.length > 0) {
      memory.contradictions = existing.map((m) => m.id);
      existing.forEach((m) => {
        if (!m.contradictions) m.contradictions = [];
        if (!m.contradictions.includes(memory.id)) {
          m.contradictions.push(memory.id);
        }
      });
    }

    this.memories.set(memory.id, memory);
    this.indexByCategory
      .get(category)
      ?.add(memory.id) ||
      this.indexByCategory.set(category, new Set([memory.id]));
    this.indexByType
      .get(type)
      ?.add(memory.id) ||
      this.indexByType.set(type, new Set([memory.id]));

    this.persist();
    return memory;
  }

  /**
   * Get a specific memory by ID.
   */
  get(id: string): SemanticMemory | null {
    return this.memories.get(id) || null;
  }

  /**
   * Get all memories in a category.
   */
  getByCategory(
    category: string,
    sortByConfidence = true
  ): SemanticMemory[] {
    const ids = this.indexByCategory.get(category) || new Set();
    const memories = Array.from(ids)
      .map((id) => this.memories.get(id)!)
      .filter(Boolean);

    if (sortByConfidence) {
      memories.sort((a, b) => b.confidence - a.confidence);
    }
    return memories;
  }

  /**
   * Get all memories of a specific type.
   */
  getByType(type: SemanticMemory["type"]): SemanticMemory[] {
    const ids = this.indexByType.get(type) || new Set();
    return Array.from(ids)
      .map((id) => this.memories.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Search memories by content.
   */
  search(query: string, limit: number = 10): SemanticMemory[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.memories.values())
      .map((mem) => {
        let score = 0;
        if (mem.content.toLowerCase().includes(q)) {
          const contentWords = mem.content
            .toLowerCase()
            .split(/\s+/);
          const queryWords = q.split(/\s+/);
          const matches = queryWords.filter((qw) =>
            contentWords.some((cw) => cw.includes(qw))
          );
          score = matches.length;
        }
        if (mem.category.toLowerCase().includes(q)) {
          score += 2;
        }
        score *= mem.confidence; // Weight by confidence
        score += mem.referenceCount * 0.1; // Boost frequently used
        return { mem, score };
      })
      .filter(({ score }) => score > 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ mem }) => mem);
  }

  /**
   * Get user preferences.
   */
  getPreferences(): SemanticMemory[] {
    return this.getByType("preference");
  }

  /**
   * Get facts.
   */
  getFacts(): SemanticMemory[] {
    return this.getByType("fact");
  }

  /**
   * Get rules.
   */
  getRules(): SemanticMemory[] {
    return this.getByType("rule");
  }

  /**
   * Record a reference to this memory (usage tracking).
   */
  recordReference(id: string): void {
    const mem = this.memories.get(id);
    if (mem) {
      mem.referenceCount++;
      mem.lastReferenced = Date.now();
      this.persist();
    }
  }

  /**
   * Update confidence in a memory.
   */
  updateConfidence(
    id: string,
    delta: number
  ): SemanticMemory | null {
    const mem = this.memories.get(id);
    if (!mem) return null;

    mem.confidence = Math.max(0, Math.min(1, mem.confidence + delta));
    mem.timestamp = Date.now();
    this.persist();
    return mem;
  }

  /**
   * Merge contradicting memories when evidence is clear.
   */
  resolveContradiction(
    keepId: string,
    removeId: string,
    confidence: number
  ): boolean {
    const keep = this.memories.get(keepId);
    const remove = this.memories.get(removeId);

    if (!keep || !remove) return false;

    // Increase confidence in the kept memory
    keep.confidence = Math.min(1, keep.confidence + confidence * 0.1);
    keep.referenceCount++;

    // Remove contradictions reference
    if (keep.contradictions) {
      keep.contradictions = keep.contradictions.filter(
        (id) => id !== removeId
      );
    }

    // Delete the conflicting memory
    this.memories.delete(removeId);

    // Remove from indexes
    const typeIds = this.indexByType.get(remove.type);
    if (typeIds) typeIds.delete(removeId);

    const catIds = this.indexByCategory.get(remove.category);
    if (catIds) catIds.delete(removeId);

    this.persist();
    return true;
  }

  /**
   * Get contradictions for a memory.
   */
  getContradictions(id: string): SemanticMemory[] {
    const mem = this.memories.get(id);
    if (!mem || !mem.contradictions) return [];

    return mem.contradictions
      .map((cid) => this.memories.get(cid)!)
      .filter(Boolean);
  }

  /**
   * Delete a memory.
   */
  delete(id: string): boolean {
    const mem = this.memories.get(id);
    if (!mem) return false;

    // Remove from indexes
    this.indexByType.get(mem.type)?.delete(id);
    this.indexByCategory.get(mem.category)?.delete(id);

    // Remove from contradictions
    if (mem.contradictions) {
      mem.contradictions.forEach((cid) => {
        const contradict = this.memories.get(cid);
        if (contradict?.contradictions) {
          contradict.contradictions = contradict.contradictions.filter(
            (mid) => mid !== id
          );
        }
      });
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
    byCategory: Record<string, number>;
    averageConfidence: number;
    withContradictions: number;
  } {
    const stats = {
      total: this.memories.size,
      byType: {} as Record<string, number>,
      byCategory: {} as Record<string, number>,
      averageConfidence: 0,
      withContradictions: 0,
    };

    let totalConfidence = 0;
    for (const mem of this.memories.values()) {
      stats.byType[mem.type] = (stats.byType[mem.type] || 0) + 1;
      stats.byCategory[mem.category] =
        (stats.byCategory[mem.category] || 0) + 1;
      totalConfidence += mem.confidence;
      if (mem.contradictions && mem.contradictions.length > 0) {
        stats.withContradictions++;
      }
    }

    stats.averageConfidence =
      this.memories.size > 0
        ? totalConfidence / this.memories.size
        : 0;

    return stats;
  }

  /**
   * Find memories that might contradict a new one.
   */
  private findPotentialContradictions(
    category: string,
    content: string,
    type: SemanticMemory["type"]
  ): SemanticMemory[] {
    // Simple heuristic: same category + type + significant content overlap
    const candidates = this.getByCategory(category).filter(
      (m) => m.type === type
    );

    const contradictions: SemanticMemory[] = [];
    const newWords = content
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    for (const candidate of candidates) {
      const candWords = candidate.content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);

      const overlap = newWords.filter((w) =>
        candWords.some((cw) => cw.includes(w) || w.includes(cw))
      ).length;

      // If significant overlap and somewhat opposite meaning, mark as contradiction
      if (overlap > 2) {
        const hasNegation =
          (content.includes("not ") || content.includes("don't")) !==
          (candidate.content.includes("not ") ||
            candidate.content.includes("don't"));

        if (hasNegation) {
          contradictions.push(candidate);
        }
      }
    }

    return contradictions;
  }

  /**
   * Clear all memories (testing).
   */
  clear(): void {
    this.memories.clear();
    this.indexByCategory.clear();
    this.indexByType.clear();
    this.persist();
  }

  /**
   * Persist to disk.
   */
  private persist(): void {
    try {
      const data = Array.from(this.memories.values());
      const dir = path.dirname(SEMANTIC_MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        SEMANTIC_MEMORY_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error(
        "[SemanticMemory] Failed to persist:",
        error
      );
    }
  }

  /**
   * Load from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(SEMANTIC_MEMORY_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(SEMANTIC_MEMORY_FILE, "utf-8")
        );
        if (Array.isArray(data)) {
          this.memories.clear();
          this.indexByCategory.clear();
          this.indexByType.clear();

          data.forEach((mem) => {
            this.memories.set(mem.id, mem);
            const typeIds = this.indexByType.get(mem.type) ||
              new Set();
            typeIds.add(mem.id);
            this.indexByType.set(mem.type, typeIds);

            const catIds = this.indexByCategory.get(mem.category) ||
              new Set();
            catIds.add(mem.id);
            this.indexByCategory.set(mem.category, catIds);
          });

          console.debug(
            `[SemanticMemory] Loaded ${this.memories.size} semantic memories`
          );
        }
      }
    } catch (error) {
      console.error(
        "[SemanticMemory] Failed to load:",
        error
      );
    }
  }

  /**
   * Generate unique ID.
   */
  private generateId(): string {
    return `sm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Singleton
let semanticEngine: SemanticMemoryEngine | null = null;

export function getSemanticMemory(): SemanticMemoryEngine {
  if (!semanticEngine) {
    semanticEngine = new SemanticMemoryEngine();
  }
  return semanticEngine;
}
