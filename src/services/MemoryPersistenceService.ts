/**
 * Memory Persistence Service
 * Handles saving, loading, and migration of all 7 memory types to disk
 * Enables learning to persist across session boundaries
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  MemoryStore,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  PreferenceMemory,
  FailureMemory,
  AchievementMemory,
  AutobiographicalMemory,
} from '../types/Memory';

export interface MemoryPersistenceConfig {
  dataDir: string;
  autoSaveInterval: number; // milliseconds
  maxBackups: number;
  compressionEnabled: boolean;
  encryptionEnabled: boolean;
}

export interface MemorySnapshot {
  timestamp: number;
  version: string;
  episodic: object;
  semantic: object;
  procedural: object;
  preference: object;
  failure: object;
  achievement: object;
  autobiographical: object;
  metadata: {
    totalMemories: number;
    averageConfidence: number;
    memoryTypes: Record<string, number>;
    lastUpdateTime: number;
  };
}

export interface LoadResult {
  success: boolean;
  memoriesLoaded: number;
  timestamp: number;
  errors: string[];
}

export class MemoryPersistenceService {
  private config: MemoryPersistenceConfig;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private lastSaveTime: number = 0;
  private isDirty: boolean = false;

  constructor(config: Partial<MemoryPersistenceConfig> = {}) {
    this.config = {
      dataDir: config.dataDir || path.join(process.cwd(), 'data', 'memories'),
      autoSaveInterval: config.autoSaveInterval || 60000, // 1 minute
      maxBackups: config.maxBackups || 10,
      compressionEnabled: config.compressionEnabled || false,
      encryptionEnabled: config.encryptionEnabled || false,
    };

    // Ensure data directory exists
    this.ensureDirectoryExists(this.config.dataDir);
    this.ensureDirectoryExists(path.join(this.config.dataDir, 'backups'));
  }

  /**
   * Save all memories to disk
   */
  async saveMemories(memoryStore: MemoryStore): Promise<boolean> {
    try {
      const snapshot = this.createSnapshot(memoryStore);
      const timestamp = Date.now();
      const filename = `memories-${timestamp}.json`;
      const filepath = path.join(this.config.dataDir, filename);

      // Write main file
      fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
      console.log(`[MemoryPersistence] Saved ${snapshot.metadata.totalMemories} memories to ${filename}`);

      // Create backup
      await this.createBackup(filepath);

      this.lastSaveTime = timestamp;
      this.isDirty = false;
      return true;
    } catch (error) {
      console.error('[MemoryPersistence] Error saving memories:', error);
      return false;
    }
  }

  /**
   * Load memories from the most recent snapshot
   */
  async loadMemories(): Promise<{ store: MemoryStore; result: LoadResult }> {
    const result: LoadResult = {
      success: false,
      memoriesLoaded: 0,
      timestamp: Date.now(),
      errors: [],
    };

    try {
      // Find most recent memory file
      const files = fs.readdirSync(this.config.dataDir);
      const memoryFiles = files
        .filter((f) => f.startsWith('memories-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (memoryFiles.length === 0) {
        console.log('[MemoryPersistence] No previous memories found, starting fresh');
        return {
          store: this.createEmptyStore(),
          result,
        };
      }

      const latestFile = memoryFiles[0];
      const filepath = path.join(this.config.dataDir, latestFile);
      const data = fs.readFileSync(filepath, 'utf-8');
      const snapshot: MemorySnapshot = JSON.parse(data);

      // Restore memories
      const store = this.restoreFromSnapshot(snapshot);

      result.success = true;
      result.memoriesLoaded = snapshot.metadata.totalMemories;
      result.timestamp = snapshot.timestamp;

      console.log(
        `[MemoryPersistence] Loaded ${result.memoriesLoaded} memories from ${latestFile}`
      );

      return { store, result };
    } catch (error) {
      result.errors.push(`Failed to load memories: ${error}`);
      console.error('[MemoryPersistence] Error loading memories:', error);
      return {
        store: this.createEmptyStore(),
        result,
      };
    }
  }

  /**
   * Export memories in various formats
   */
  async exportMemories(
    memoryStore: MemoryStore,
    format: 'json' | 'csv' | 'markdown' = 'json'
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      const snapshot = this.createSnapshot(memoryStore);
      const filename = `memories-export-${timestamp}.json`;
      const filepath = path.join(this.config.dataDir, 'exports', filename);
      this.ensureDirectoryExists(path.join(this.config.dataDir, 'exports'));
      fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
      return filepath;
    } else if (format === 'markdown') {
      return this.exportAsMarkdown(memoryStore, timestamp);
    } else if (format === 'csv') {
      return this.exportAsCSV(memoryStore, timestamp);
    }

    throw new Error(`Unsupported export format: ${format}`);
  }

  /**
   * Get memory statistics
   */
  getMemoryStats(memoryStore: MemoryStore): {
    totalMemories: number;
    byType: Record<string, number>;
    averageConfidence: number;
    oldestMemory: number | null;
    newestMemory: number | null;
    lastSaveTime: number;
  } {
    let totalMemories = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;
    let oldestMemory: number | null = null;
    let newestMemory: number | null = null;

    const byType: Record<string, number> = {
      episodic: memoryStore.episodic.size,
      semantic: memoryStore.semantic.size,
      procedural: memoryStore.procedural.size,
      preference: memoryStore.preference.size,
      failure: memoryStore.failure.size,
      achievement: memoryStore.achievement.size,
      autobiographical: memoryStore.autobiographical.size,
    };

    // Episodic
    memoryStore.episodic.forEach((mem) => {
      totalMemories++;
      confidenceSum += mem.confidence ?? 0.5;
      confidenceCount++;
      const time = new Date(mem.timestamp).getTime();
      if (!oldestMemory || time < oldestMemory) oldestMemory = time;
      if (!newestMemory || time > newestMemory) newestMemory = time;
    });

    // Semantic
    memoryStore.semantic.forEach((mem) => {
      totalMemories++;
      confidenceSum += mem.confidence ?? 0.5;
      confidenceCount++;
    });

    // Procedural
    memoryStore.procedural.forEach((mem) => {
      totalMemories++;
      confidenceSum += mem.skill.confidence ?? 0.5;
      confidenceCount++;
    });

    // Preference
    memoryStore.preference.forEach((mem) => {
      totalMemories++;
      confidenceSum += mem.confidence ?? 0.7;
      confidenceCount++;
    });

    // Failure
    memoryStore.failure.forEach((mem) => {
      totalMemories++;
      confidenceSum += 0.5; // Implicit
      confidenceCount++;
    });

    // Achievement
    memoryStore.achievement.forEach((mem) => {
      totalMemories++;
      confidenceSum += mem.achievement.verificationQuality ?? 0.8;
      confidenceCount++;
    });

    // Autobiographical
    memoryStore.autobiographical.forEach((mem) => {
      totalMemories++;
      confidenceSum += 0.75; // Implicit
      confidenceCount++;
    });

    return {
      totalMemories,
      byType,
      averageConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
      oldestMemory,
      newestMemory,
      lastSaveTime: this.lastSaveTime,
    };
  }

  /**
   * Enable auto-save
   */
  enableAutoSave(memoryStore: MemoryStore): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(() => {
      if (this.isDirty) {
        this.saveMemories(memoryStore);
      }
    }, this.config.autoSaveInterval);

    console.log(`[MemoryPersistence] Auto-save enabled every ${this.config.autoSaveInterval}ms`);
  }

  /**
   * Mark memories as changed
   */
  markDirty(): void {
    this.isDirty = true;
  }

  /**
   * Stop auto-save
   */
  disableAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Get last save time
   */
  getLastSaveTime(): number {
    return this.lastSaveTime;
  }

  // ============ Private Helpers ============

  private createSnapshot(memoryStore: MemoryStore): MemorySnapshot {
    const stats = this.getMemoryStats(memoryStore);

    return {
      timestamp: Date.now(),
      version: '1.0.0',
      episodic: Array.from(memoryStore.episodic.values()),
      semantic: Array.from(memoryStore.semantic.values()),
      procedural: Array.from(memoryStore.procedural.values()),
      preference: Array.from(memoryStore.preference.values()),
      failure: Array.from(memoryStore.failure.values()),
      achievement: Array.from(memoryStore.achievement.values()),
      autobiographical: Array.from(memoryStore.autobiographical.values()),
      metadata: {
        totalMemories: stats.totalMemories,
        averageConfidence: stats.averageConfidence,
        memoryTypes: stats.byType,
        lastUpdateTime: Date.now(),
      },
    };
  }

  private restoreFromSnapshot(snapshot: MemorySnapshot): MemoryStore {
    const store = this.createEmptyStore();

    // Restore episodic
    (snapshot.episodic as EpisodicMemory[]).forEach((mem) => {
      store.episodic.set(mem.id, mem);
    });

    // Restore semantic
    (snapshot.semantic as SemanticMemory[]).forEach((mem) => {
      store.semantic.set(mem.id, mem);
    });

    // Restore procedural
    (snapshot.procedural as ProceduralMemory[]).forEach((mem) => {
      store.procedural.set(mem.id, mem);
    });

    // Restore preference
    (snapshot.preference as PreferenceMemory[]).forEach((mem) => {
      store.preference.set(mem.id, mem);
    });

    // Restore failure
    (snapshot.failure as FailureMemory[]).forEach((mem) => {
      store.failure.set(mem.id, mem);
    });

    // Restore achievement
    (snapshot.achievement as AchievementMemory[]).forEach((mem) => {
      store.achievement.set(mem.id, mem);
    });

    // Restore autobiographical
    (snapshot.autobiographical as AutobiographicalMemory[]).forEach((mem) => {
      store.autobiographical.set(mem.id, mem);
    });

    return store;
  }

  private createEmptyStore(): MemoryStore {
    return {
      episodic: new Map(),
      semantic: new Map(),
      procedural: new Map(),
      preference: new Map(),
      failure: new Map(),
      achievement: new Map(),
      autobiographical: new Map(),
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    };
  }

  private async createBackup(filepath: string): Promise<void> {
    try {
      const backupDir = path.join(this.config.dataDir, 'backups');
      const filename = path.basename(filepath);
      const backupPath = path.join(backupDir, filename);

      fs.copyFileSync(filepath, backupPath);

      // Clean old backups
      const backups = fs.readdirSync(backupDir).sort();
      if (backups.length > this.config.maxBackups) {
        for (let i = 0; i < backups.length - this.config.maxBackups; i++) {
          fs.unlinkSync(path.join(backupDir, backups[i]));
        }
      }
    } catch (error) {
      console.warn('[MemoryPersistence] Warning: Failed to create backup:', error);
    }
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private exportAsMarkdown(memoryStore: MemoryStore, timestamp: string): string {
    const lines: string[] = [];
    lines.push('# SARA Memory Export\n');
    lines.push(`Generated: ${new Date().toISOString()}\n`);

    const stats = this.getMemoryStats(memoryStore);
    lines.push(`## Summary\n`);
    lines.push(`- Total Memories: ${stats.totalMemories}`);
    lines.push(`- Average Confidence: ${(stats.averageConfidence * 100).toFixed(1)}%`);
    lines.push(`- Memory Types: ${JSON.stringify(stats.byType)}\n`);

    lines.push(`## Episodic Memories (${memoryStore.episodic.size})\n`);
    memoryStore.episodic.forEach((mem) => {
      lines.push(`- **${mem.event.description}** (${new Date(mem.event.timestamp).toISOString()})`);
      lines.push(`  - Outcome: ${mem.event.outcome}`);
      lines.push(`  - Confidence: ${(mem.confidence) * 100}%\n`);
    });

    lines.push(`## Semantic Memories (${memoryStore.semantic.size})\n`);
    memoryStore.semantic.forEach((mem) => {
      lines.push(`- ${mem.fact.statement}`);
      lines.push(`  - Category: ${mem.fact.category}`);
      lines.push(`  - Confidence: ${(mem.confidence) * 100}%\n`);
    });

    lines.push(`## Achievement Memories (${memoryStore.achievement.size})\n`);
    memoryStore.achievement.forEach((mem) => {
      lines.push(`- **${mem.achievement.taskType}** - ${mem.achievement.goal}`);
      lines.push(`  - Duration: ${mem.achievement.executionTime}ms`);
      lines.push(`  - Quality: ${(mem.achievement.verificationQuality * 100).toFixed(1)}%`);
      lines.push(`  - Reusable: ${mem.achievement.reusable}\n`);
    });

    lines.push(`## Failure Memories (${memoryStore.failure.size})\n`);
    memoryStore.failure.forEach((mem) => {
      lines.push(`- **${mem.failure.taskType}** - ${mem.failure.failureType}`);
      lines.push(`  - Root Cause: ${mem.failure.rootCause}`);
      lines.push(`  - Repeat Count: ${mem.failure.repeatCount}\n`);
    });

    const filename = `memories-export-${timestamp}.md`;
    const filepath = path.join(this.config.dataDir, 'exports', filename);
    this.ensureDirectoryExists(path.join(this.config.dataDir, 'exports'));
    fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');
    return filepath;
  }

  private exportAsCSV(memoryStore: MemoryStore, timestamp: string): string {
    const lines: string[] = [];
    lines.push('Type,ID,Content,Confidence,Timestamp');

    memoryStore.episodic.forEach((mem) => {
      lines.push(
        `Episodic,${mem.id},"${mem.event.description}",${mem.confidence ?? 0.5},${mem.timestamp}`
      );
    });

    memoryStore.semantic.forEach((mem) => {
      lines.push(`Semantic,${mem.id},"${mem.fact.statement}",${mem.confidence ?? 0.5},${mem.timestamp}`);
    });

    memoryStore.achievement.forEach((mem) => {
      lines.push(
        `Achievement,${mem.id},"${mem.achievement.taskType}",${mem.achievement.verificationQuality},${mem.timestamp}`
      );
    });

    memoryStore.failure.forEach((mem) => {
      lines.push(`Failure,${mem.id},"${mem.failure.failureType}",${mem.confidence ?? 0.5},${mem.timestamp}`);
    });

    const filename = `memories-export-${timestamp}.csv`;
    const filepath = path.join(this.config.dataDir, 'exports', filename);
    this.ensureDirectoryExists(path.join(this.config.dataDir, 'exports'));
    fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');
    return filepath;
  }
}

// Singleton instance
let persistenceInstance: MemoryPersistenceService | null = null;

export function getMemoryPersistenceService(
  config?: Partial<MemoryPersistenceConfig>
): MemoryPersistenceService {
  if (!persistenceInstance) {
    persistenceInstance = new MemoryPersistenceService(config);
  }
  return persistenceInstance;
}
