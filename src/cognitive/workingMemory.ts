/**
 * Working Memory System
 *
 * Manages the active context relevant to the current task.
 * Automatically cleans up old/low-priority items.
 * Not persisted - only for active task context.
 */

import { WorkingMemoryItem, WorkingMemoryState } from "./types";

const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes default
const CLEANUP_INTERVAL = 60 * 1000; // Clean every minute
const MAX_ITEMS = 100; // Prevent unbounded growth

export class WorkingMemory {
  private state: WorkingMemoryState;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.state = {
      items: new Map(),
      lastCleanup: Date.now(),
    };
    this.startAutoCleanup();
  }

  /**
   * Add or update an item in working memory.
   * Returns true if added, false if updated.
   */
  set(
    key: string,
    value: unknown,
    options: {
      source?: string;
      ttl?: number;
      priority?: number;
    } = {}
  ): boolean {
    const existing = this.state.items.get(key);
    const isNew = !existing;

    const item: WorkingMemoryItem = {
      id: existing?.id || this.generateId(),
      key,
      value,
      source: options.source || "unknown",
      timestamp: Date.now(),
      ttl: options.ttl ?? DEFAULT_TTL,
      priority: options.priority ?? 5,
    };

    this.state.items.set(key, item);

    // Clean up if we exceed capacity
    if (this.state.items.size > MAX_ITEMS) {
      this.evictLowPriority();
    }

    return isNew;
  }

  /**
   * Get an item from working memory.
   */
  get(key: string): unknown {
    const item = this.state.items.get(key);
    return item?.value;
  }

  /**
   * Get an item with full metadata.
   */
  getItem(key: string): WorkingMemoryItem | undefined {
    return this.state.items.get(key);
  }

  /**
   * Check if a key exists.
   */
  has(key: string): boolean {
    return this.state.items.has(key);
  }

  /**
   * Delete an item.
   */
  delete(key: string): boolean {
    return this.state.items.delete(key);
  }

  /**
   * Clear all items (task completion).
   */
  clear(): void {
    this.state.items.clear();
    this.state.lastCleanup = Date.now();
  }

  /**
   * Get all items.
   */
  all(): WorkingMemoryItem[] {
    return Array.from(this.state.items.values());
  }

  /**
   * Get items by priority (highest first).
   */
  byPriority(): WorkingMemoryItem[] {
    return this.all().sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get items by source.
   */
  bySource(source: string): WorkingMemoryItem[] {
    return this.all().filter((item) => item.source === source);
  }

  /**
   * Update priority of an item.
   */
  setPriority(key: string, priority: number): void {
    const item = this.state.items.get(key);
    if (item) {
      item.priority = priority;
      item.timestamp = Date.now(); // Refresh timestamp
    }
  }

  /**
   * Get summary of working memory for context.
   */
  summary(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const item of this.byPriority()) {
      if (item.priority >= 5) {
        // Only include high-priority items
        result[item.key] = item.value;
      }
    }
    return result;
  }

  /**
   * Remove expired items.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, item] of this.state.items) {
      if (item.ttl && now - item.timestamp > item.ttl) {
        this.state.items.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.debug(`[WorkingMemory] Cleaned up ${removed} expired items`);
    }

    this.state.lastCleanup = now;
  }

  /**
   * Evict the lowest priority items when capacity exceeded.
   */
  private evictLowPriority(): void {
    const threshold = MAX_ITEMS * 0.9; // Keep 90% at most
    const items = this.byPriority();
    const toRemove = items.length - Math.floor(threshold);

    if (toRemove > 0) {
      const removed = items.slice(-toRemove);
      for (const item of removed) {
        this.state.items.delete(item.key);
      }
      console.debug(`[WorkingMemory] Evicted ${toRemove} low-priority items`);
    }
  }

  /**
   * Start automatic cleanup timer.
   */
  private startAutoCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  /**
   * Stop the cleanup timer.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Generate unique ID for items.
   */
  private generateId(): string {
    return `wm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Global singleton
let globalWorkingMemory: WorkingMemory | null = null;

export function getWorkingMemory(): WorkingMemory {
  if (!globalWorkingMemory) {
    globalWorkingMemory = new WorkingMemory();
  }
  return globalWorkingMemory;
}

export function resetWorkingMemory(): void {
  if (globalWorkingMemory) {
    globalWorkingMemory.shutdown();
  }
  globalWorkingMemory = new WorkingMemory();
}
