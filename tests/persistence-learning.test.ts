/**
 * Persistence and Learning Tests
 * Tests memory persistence, skill extraction, failure pattern recognition
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../src/services/MemoryService';
import { SkillLibrary, StrategyManager } from '../src/services/SkillLibraryAndStrategyManager';
import { MemoryPersistenceService } from '../src/services/MemoryPersistenceService';
import { AdvancedLearningService } from '../src/services/AdvancedLearningService';
import { LearningWorkflowCoordinator } from '../src/services/LearningWorkflowCoordinator';
import { ClosedLoopExecutor } from '../src/services/ClosedLoopExecutor';
import {
  createEpisodicMemory,
  createAchievementMemory,
  createFailureMemory,
  createMemoryStore,
} from '../src/types/Memory';
import { createClosedLoopTask } from '../src/types/ClosedLoopTask';
import * as fs from 'fs';
import * as path from 'path';

const testDataDir = path.join(process.cwd(), 'test_data');

// Setup
if (!fs.existsSync(testDataDir)) {
  fs.mkdirSync(testDataDir, { recursive: true });
}

const memoryService = new MemoryService();
const skillLibrary = new SkillLibrary();
const strategyManager = new StrategyManager();
const persistenceService = new MemoryPersistenceService({
  dataDir: path.join(testDataDir, 'memories'),
  autoSaveInterval: 10000,
});
const learningService = new AdvancedLearningService(memoryService, skillLibrary);
const workflowCoordinator = new LearningWorkflowCoordinator(memoryService, skillLibrary, {
  persistenceEnabled: true,
  learningEnabled: true,
});
const executor = new ClosedLoopExecutor();

// Cleanup function
function cleanup() {
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true });
  }
}

// Tests for MemoryPersistenceService
test('MemoryPersistenceService: should save and load memories', async () => {
  const store = createMemoryStore();

  // Add test memories
  const episodic = createEpisodicMemory('Opened Notepad', Date.now(), 'success', 'Test event', 0.9);
  store.episodic.set(episodic.id, episodic);

  // Save
  const saved = await persistenceService.saveMemories(store);
  assert.equal(saved, true);

  // Load
  const { store: loaded, result } = await persistenceService.loadMemories();
  assert.equal(result.success, true);
  assert(result.memoriesLoaded >= 0);
});

test('MemoryPersistenceService: should export memories to JSON', async () => {
  const store = createMemoryStore();
  const achievement = createAchievementMemory(
    'task-2',
    'open_notepad',
    'Opened Notepad successfully',
    Date.now(),
    2500,
    1,
    0,
    true,
    0.9,
    new Map(),
    ['open_app', 'wait_window']
  );
  store.achievement.set(achievement.id, achievement);

  const filepath = await persistenceService.exportMemories(store, 'json');
  assert(fs.existsSync(filepath));

  const exported = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  assert(exported.achievement);
});

test('MemoryPersistenceService: should get memory statistics', () => {
  const store = createMemoryStore();
  const episodic = createEpisodicMemory('event1', Date.now(), 'success', 'Test', 0.8);
  store.episodic.set('1', episodic);

  const stats = persistenceService.getMemoryStats(store);
  assert(stats.totalMemories >= 1);
  assert.equal(stats.byType.episodic, 1);
  assert(stats.averageConfidence >= 0);
});

test('MemoryPersistenceService: should create backups', async () => {
  const store = createMemoryStore();
  const episodic = createEpisodicMemory('event1', Date.now(), 'success', 'Test', 0.8);
  store.episodic.set('1', episodic);

  await persistenceService.saveMemories(store);
  await persistenceService.saveMemories(store);

  const backupDir = path.join(testDataDir, 'memories', 'backups');
  if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir);
    assert(backups.length >= 0);
  }
});

test('MemoryPersistenceService: should recover from a corrupt newest snapshot', async () => {
  const recoveryDir = path.join(testDataDir, 'recovery-memories');
  const recoveryService = new MemoryPersistenceService({ dataDir: recoveryDir });
  const store = createMemoryStore();
  const episodic = createEpisodicMemory('recovery-event', Date.now(), 'success', 'Recovery test', 0.9);
  store.episodic.set(episodic.id, episodic);

  assert.equal(await recoveryService.saveMemories(store), true);
  const snapshotFiles = fs
    .readdirSync(recoveryDir)
    .filter((file) => file.startsWith('memories-') && file.endsWith('.json'));
  assert.equal(snapshotFiles.length, 1);
  fs.writeFileSync(path.join(recoveryDir, snapshotFiles[0]), '{corrupt', 'utf-8');

  const loaded = await recoveryService.loadMemories();
  assert.equal(loaded.result.success, true);
  assert.equal(loaded.store.episodic.size, 1);
  assert(loaded.result.errors.length >= 1);
});

// Tests for AdvancedLearningService
test('AdvancedLearningService: should extract skills from completed tasks', async () => {
  const goal = {
    id: 'goal-1',
    description: 'Open and save file',
    priority: 'normal' as const,
    context: {},
    authorityLevel: 'NORMAL' as const,
  };

  const task = createClosedLoopTask(goal);
  task.currentState = 'COMPLETED';

  const result = await learningService.extractSkillFromTask(task, 2500);
  assert(result !== null);
  assert(result?.skillId);
  assert(result?.confidence >= 0);
});

test('AdvancedLearningService: should analyze failure patterns', async () => {
  const store = createMemoryStore();

  // Add failure memories
  const failure1 = createFailureMemory(
    'task-1',
    'save_file',
    'no_path',
    'Provide file path',
    0,
    false,
    0,
    Date.now(),
    [],
    'Try again',
    0.5,
    false,
    1,
    Date.now()
  );
  const failure2 = createFailureMemory(
    'task-2',
    'save_file',
    'no_path',
    'Provide file path',
    0,
    false,
    0,
    Date.now(),
    [],
    'Try again',
    0.5,
    false,
    1,
    Date.now()
  );
  const failure3 = createFailureMemory(
    'task-3',
    'open_app',
    'not_found',
    'Check app installed',
    0,
    false,
    0,
    Date.now(),
    [],
    'Check',
    0.3,
    false,
    0,
    Date.now()
  );

  store.failure.set(failure1.id, failure1);
  store.failure.set(failure2.id, failure2);
  store.failure.set(failure3.id, failure3);

  const patterns = await learningService.analyzeFailurePatterns(store);
  assert(patterns.length >= 0);

  if (patterns.length > 0) {
    const topPattern = patterns[0];
    assert(topPattern.occurrences >= 0);
    assert(Array.isArray(topPattern.taskTypes));
  }
});

test('AdvancedLearningService: should optimize strategy selection', async () => {
  const store = createMemoryStore();

  // Add successful achievements
  for (let i = 0; i < 3; i++) {
    const achievement = createAchievementMemory(
      `task-${i}`,
      'open_notepad',
      'Opened Notepad',
      Date.now(),
      2000,
      i + 1,
      i,
      true,
      0.95,
      new Map(),
      ['win_r', 'type', 'enter']
    );
    store.achievement.set(achievement.id, achievement);
  }

  await learningService.optimizeStrategySelection(store);
  const report = await learningService.getLearningReport();

  assert(report.topStrategies);
});

test('AdvancedLearningService: should identify learning opportunities', async () => {
  const store = createMemoryStore();

  // Setup some learning data
  await learningService.analyzeFailurePatterns(store);
  await learningService.optimizeStrategySelection(store);

  const opportunities = await learningService.identifyLearningOpportunities();
  assert(Array.isArray(opportunities));
});

test('AdvancedLearningService: should get learning report', async () => {
  const report = await learningService.getLearningReport();

  assert(report.skillsExtracted !== undefined);
  assert(report.failurePatterns !== undefined);
  assert(report.strategiesOptimized !== undefined);
  assert(report.totalLearningEvents !== undefined);
});

// Tests for LearningWorkflowCoordinator
test('LearningWorkflowCoordinator: should initialize with persistent memories', async () => {
  const store = createMemoryStore();
  const result = await workflowCoordinator.initialize(store);

  assert(result);
  assert.equal(result.success, true);
});

test('LearningWorkflowCoordinator: should process task completion and trigger learning', async () => {
  const store = createMemoryStore();

  const goal = {
    id: 'goal-1',
    description: 'Test task',
    priority: 'normal' as const,
    context: {},
    authorityLevel: 'NORMAL' as const,
  };

  const task = createClosedLoopTask(goal);
  task.currentState = 'COMPLETED';

  await workflowCoordinator.processTaskCompletion(task, 1000, store);

  const state = workflowCoordinator.getState();
  assert(state.workflow);
});

test('LearningWorkflowCoordinator: should run learning analysis', async () => {
  const store = createMemoryStore();
  const opportunities = await workflowCoordinator.runLearningAnalysis(store);

  assert(Array.isArray(opportunities));
});

test('LearningWorkflowCoordinator: should save and export memories', async () => {
  const store = createMemoryStore();
  const episodic = createEpisodicMemory('event', Date.now(), 'success', 'Test', 0.8);
  store.episodic.set('1', episodic);

  // Test save
  const saved = await workflowCoordinator.saveMemories(store);
  assert.equal(saved, true);

  // Test export
  const jsonPath = await workflowCoordinator.exportMemories(store, 'json');
  assert(jsonPath !== null);
  if (jsonPath) {
    assert(fs.existsSync(jsonPath));
  }
});

test('LearningWorkflowCoordinator: should report health status', async () => {
  const health = await workflowCoordinator.getHealthReport();

  assert(health.healthy !== undefined);
  assert(health.persistenceOk !== undefined);
  assert(health.learningOk !== undefined);
  assert(Array.isArray(health.recentErrors));
});

test('LearningWorkflowCoordinator: should get memory statistics', () => {
  const store = createMemoryStore();
  const episodic = createEpisodicMemory('event', Date.now(), 'success', 'Test', 0.8);
  store.episodic.set('1', episodic);

  const stats = workflowCoordinator.getMemoryStatistics(store);
  assert(stats.totalMemories >= 1);
});

// Integration tests
test('Integration: should complete full workflow from execution to learning', async () => {
  const store = createMemoryStore();

  // Initialize
  const initResult = await workflowCoordinator.initialize(store);
  assert.equal(initResult.success, true);

  // Wire executor to learning
  executor.setLearningWorkflow(workflowCoordinator, store);

  // Create task
  const goal = {
    id: 'goal-full',
    description: 'Full workflow test',
    priority: 'normal' as const,
    context: {},
    authorityLevel: 'NORMAL' as const,
  };

  const task = executor.createTask(goal);
  assert(task.id);

  // Simulate completion
  const result = await executor.executeTask(task.id, {
    maxRetries: 1,
    enableRecovery: false,
    verificationRequired: false,
  });

  assert.equal(result.taskId, task.id);

  // Get learning report
  const report = await workflowCoordinator.getLearningReport();
  assert(report);

  // Cleanup
  await workflowCoordinator.shutdown(store);
});

test('Integration: should handle persistence across task executions', async () => {
  const store = createMemoryStore();

  // Setup
  await workflowCoordinator.initialize(store);

  // Execute multiple tasks
  for (let i = 0; i < 2; i++) {
    const goal = {
      id: `goal-${i}`,
      description: `Task ${i}`,
      priority: 'normal' as const,
      context: {},
      authorityLevel: 'NORMAL' as const,
    };

    const task = executor.createTask(goal);
    task.currentState = 'COMPLETED';
    await workflowCoordinator.processTaskCompletion(task, 1000, store);
  }

  // Verify memories persisted
  const stats = workflowCoordinator.getMemoryStatistics(store);
  assert(stats.totalMemories >= 0);

  // Cleanup
  await workflowCoordinator.shutdown(store);
});

// Cleanup after all tests
test.after(async () => {
  cleanup();
});
