/**
 * Learning Workflow Coordinator
 * Orchestrates persistence, learning, and continuous improvement
 * Ties together memory persistence, skill extraction, and strategy optimization
 */

import { ClosedLoopTask } from '../types/ClosedLoopTask';
import { MemoryStore } from '../types/Memory';
import { MemoryService } from './MemoryService';
import { SkillLibrary } from './SkillLibraryAndStrategyManager';
import {
  MemoryPersistenceService,
  MemoryPersistenceConfig,
  LoadResult,
} from './MemoryPersistenceService';
import { AdvancedLearningService, LearningOpportunity } from './AdvancedLearningService';

export interface LearningWorkflowConfig {
  persistenceEnabled: boolean;
  autoSaveInterval: number;
  learningEnabled: boolean;
  skillExtractionEnabled: boolean;
  patternRecognitionEnabled: boolean;
  strategyOptimizationEnabled: boolean;
}

export interface WorkflowState {
  status: 'idle' | 'learning' | 'saving' | 'analyzing';
  lastTaskProcessed: string | null;
  tasksProcessedSinceLastSave: number;
  learningEventsThisSession: number;
  persistenceErrors: string[];
  learningErrors: string[];
}

export class LearningWorkflowCoordinator {
  private memoryService: MemoryService;
  private skillLibrary: SkillLibrary;
  private persistenceService: MemoryPersistenceService;
  private learningService: AdvancedLearningService;
  private config: LearningWorkflowConfig;
  private state: WorkflowState = {
    status: 'idle',
    lastTaskProcessed: null,
    tasksProcessedSinceLastSave: 0,
    learningEventsThisSession: 0,
    persistenceErrors: [],
    learningErrors: [],
  };

  constructor(
    memoryService: MemoryService,
    skillLibrary: SkillLibrary,
    config: Partial<LearningWorkflowConfig> = {},
    persistenceConfig: Partial<MemoryPersistenceConfig> = {}
  ) {
    this.memoryService = memoryService;
    this.skillLibrary = skillLibrary;
    this.persistenceService = new MemoryPersistenceService(persistenceConfig);
    this.learningService = new AdvancedLearningService(memoryService, skillLibrary);

    this.config = {
      persistenceEnabled: config.persistenceEnabled ?? true,
      autoSaveInterval: config.autoSaveInterval ?? 300000, // 5 minutes
      learningEnabled: config.learningEnabled ?? true,
      skillExtractionEnabled: config.skillExtractionEnabled ?? true,
      patternRecognitionEnabled: config.patternRecognitionEnabled ?? true,
      strategyOptimizationEnabled: config.strategyOptimizationEnabled ?? true,
    };
  }

  /**
   * Initialize the learning workflow
   * - Load persisted memories
   * - Set up auto-save
   * - Start learning analysis
   */
  async initialize(memoryStore: MemoryStore): Promise<LoadResult> {
    console.log('[LearningWorkflow] Initializing...');

    try {
      // Load persisted memories
      let loadResult: LoadResult;
      if (this.config.persistenceEnabled) {
        const result = await this.persistenceService.loadMemories();
        loadResult = result.result;

        // Merge loaded memories with current store
        if (loadResult.success && result.store) {
          console.log(`[LearningWorkflow] Loaded ${loadResult.memoriesLoaded} persisted memories`);
        } else if (!loadResult.success && loadResult.memoriesLoaded === 0) {
          // No previous memories is OK - it's a fresh start
          loadResult.success = true;
          console.log('[LearningWorkflow] Starting fresh with no previous memories');
        }
      } else {
        loadResult = {
          success: true,
          memoriesLoaded: 0,
          timestamp: Date.now(),
          errors: [],
        };
      }

      // Enable auto-save if configured
      if (this.config.persistenceEnabled) {
        this.persistenceService.enableAutoSave(memoryStore);
      }

      // Start learning analysis
      if (this.config.learningEnabled) {
        await this.runLearningAnalysis(memoryStore);
      }

      this.state.status = 'idle';
      console.log('[LearningWorkflow] Initialization complete');

      return loadResult;
    } catch (error) {
      const errorMsg = `Initialization failed: ${error}`;
      this.state.persistenceErrors.push(errorMsg);
      console.error('[LearningWorkflow]', errorMsg);

      return {
        success: false,
        memoriesLoaded: 0,
        timestamp: Date.now(),
        errors: [errorMsg],
      };
    }
  }

  /**
   * Process task completion
   * - Extract skills if successful
   * - Update strategy metrics
   * - Persist memories
   * - Run learning analysis periodically
   */
  async processTaskCompletion(
    task: ClosedLoopTask,
    duration: number,
    memoryStore: MemoryStore
  ): Promise<void> {
    this.state.status = 'learning';
    this.state.lastTaskProcessed = task.id;
    this.state.tasksProcessedSinceLastSave++;

    try {
      // Extract skills from successful completions
      if (this.config.skillExtractionEnabled && task.currentState === 'COMPLETED') {
        const extraction = await this.learningService.extractSkillFromTask(task, duration);
        if (extraction) {
          this.state.learningEventsThisSession++;
        }
      }

      // Mark memory as dirty for auto-save
      if (this.config.persistenceEnabled) {
        this.persistenceService.markDirty();
      }

      // Run full analysis periodically
      if (this.state.tasksProcessedSinceLastSave % 10 === 0) {
        await this.runLearningAnalysis(memoryStore);
      }
    } catch (error) {
      const errorMsg = `Error processing task completion: ${error}`;
      this.state.learningErrors.push(errorMsg);
      console.error('[LearningWorkflow]', errorMsg);
    }

    this.state.status = 'idle';
  }

  /**
   * Run full learning analysis
   * - Analyze failure patterns
   * - Optimize strategy selection
   * - Identify learning opportunities
   */
  async runLearningAnalysis(memoryStore: MemoryStore): Promise<LearningOpportunity[]> {
    this.state.status = 'analyzing';

    try {
      const opportunities: LearningOpportunity[] = [];

      // Analyze failure patterns
      if (this.config.patternRecognitionEnabled) {
        await this.learningService.analyzeFailurePatterns(memoryStore);
      }

      // Optimize strategies
      if (this.config.strategyOptimizationEnabled) {
        await this.learningService.optimizeStrategySelection(memoryStore);
      }

      // Identify learning opportunities
      opportunities.push(...(await this.learningService.identifyLearningOpportunities()));

      console.log(
        `[LearningWorkflow] Analysis complete: ${opportunities.length} learning opportunities identified`
      );

      this.state.status = 'idle';
      return opportunities;
    } catch (error) {
      const errorMsg = `Error running learning analysis: ${error}`;
      this.state.learningErrors.push(errorMsg);
      console.error('[LearningWorkflow]', errorMsg);

      this.state.status = 'idle';
      return [];
    }
  }

  /**
   * Save memories to disk
   */
  async saveMemories(memoryStore: MemoryStore): Promise<boolean> {
    if (!this.config.persistenceEnabled) {
      return true;
    }

    this.state.status = 'saving';

    try {
      const success = await this.persistenceService.saveMemories(memoryStore);

      if (success) {
        this.state.tasksProcessedSinceLastSave = 0;
        console.log('[LearningWorkflow] Memories saved successfully');
      } else {
        this.state.persistenceErrors.push('Failed to save memories');
      }

      this.state.status = 'idle';
      return success;
    } catch (error) {
      const errorMsg = `Error saving memories: ${error}`;
      this.state.persistenceErrors.push(errorMsg);
      console.error('[LearningWorkflow]', errorMsg);

      this.state.status = 'idle';
      return false;
    }
  }

  /**
   * Export memories in various formats
   */
  async exportMemories(
    memoryStore: MemoryStore,
    format: 'json' | 'csv' | 'markdown' = 'json'
  ): Promise<string | null> {
    try {
      const filepath = await this.persistenceService.exportMemories(memoryStore, format);
      console.log(`[LearningWorkflow] Memories exported to ${filepath}`);
      return filepath;
    } catch (error) {
      const errorMsg = `Error exporting memories: ${error}`;
      this.state.persistenceErrors.push(errorMsg);
      console.error('[LearningWorkflow]', errorMsg);
      return null;
    }
  }

  /**
   * Get current workflow state and statistics
   */
  getState(): {
    workflow: WorkflowState;
    persistence: {
      lastSaveTime: number;
      lastSaveStats: Record<string, number> | null;
    };
    learning: Awaited<ReturnType<AdvancedLearningService['getLearningReport']>> | null;
  } {
    return {
      workflow: { ...this.state },
      persistence: {
        lastSaveTime: this.persistenceService.getLastSaveTime(),
        lastSaveStats: null,
      },
      learning: null, // Will be populated on demand
    };
  }

  /**
   * Get learning report
   */
  async getLearningReport(): Promise<Awaited<ReturnType<AdvancedLearningService['getLearningReport']>>> {
    return this.learningService.getLearningReport();
  }

  /**
   * Improve task execution plan based on learned knowledge
   */
  async improveTask(task: ClosedLoopTask, memoryStore: MemoryStore): Promise<ClosedLoopTask> {
    return this.learningService.improveTaskPlan(task, memoryStore);
  }

  /**
   * Get memory statistics
   */
  getMemoryStatistics(memoryStore: MemoryStore) {
    return this.persistenceService.getMemoryStats(memoryStore);
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown(memoryStore: MemoryStore): Promise<void> {
    console.log('[LearningWorkflow] Shutting down...');

    // Final save
    if (this.config.persistenceEnabled) {
      await this.saveMemories(memoryStore);
      this.persistenceService.disableAutoSave();
    }

    console.log('[LearningWorkflow] Shutdown complete');
  }

  /**
   * Check workflow health
   */
  async getHealthReport(): Promise<{
    healthy: boolean;
    persistenceOk: boolean;
    learningOk: boolean;
    recentErrors: string[];
  }> {
    const allErrors = [...this.state.persistenceErrors, ...this.state.learningErrors];
    const recentErrors = allErrors.slice(-5);

    return {
      healthy: recentErrors.length === 0,
      persistenceOk: this.state.persistenceErrors.length === 0,
      learningOk: this.state.learningErrors.length === 0,
      recentErrors,
    };
  }
}

// Singleton instance
let workflowInstance: LearningWorkflowCoordinator | null = null;

export function getLearningWorkflowCoordinator(
  memoryService: MemoryService,
  skillLibrary: SkillLibrary,
  config?: Partial<LearningWorkflowConfig>,
  persistenceConfig?: Partial<MemoryPersistenceConfig>
): LearningWorkflowCoordinator {
  if (!workflowInstance) {
    workflowInstance = new LearningWorkflowCoordinator(
      memoryService,
      skillLibrary,
      config,
      persistenceConfig
    );
  }
  return workflowInstance;
}
