/**
 * SARA Closed-Loop Autonomous Desktop Acceptance Tests
 * Tests the full autonomous execution pipeline with real desktop operations
 */

import { closedLoopExecutor } from '../../src/services/ClosedLoopExecutor';
import { memoryService } from '../../src/services/MemoryService';
import { skillLibrary, strategyManager } from '../../src/services/SkillLibraryAndStrategyManager';
import { screenPerception } from '../../src/services/ScreenPerceptionEngine';
import type { Goal } from '../../src/types/ClosedLoopTask';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

interface TestResult {
  name: string;
  passed: boolean;
  status?: 'PASSED' | 'FAILED' | 'SKIPPED';
  duration: number;
  evidence: string[];
  error?: string;
}

async function callDesktopTool(tool: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
  const baseUrl = (process.env.DESKTOP_AGENT_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || `Desktop agent ${tool} returned HTTP ${response.status}.`);
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

function skipped(name: string, startTime: number, reason: string): TestResult {
  return { name, passed: false, status: 'SKIPPED', duration: Date.now() - startTime, evidence: [reason] };
}

export class ClosedLoopAutonomousAcceptanceTests {
  private results: TestResult[] = [];
  private requiresRealDesktop: boolean = false;

  constructor() {
    this.requiresRealDesktop =
      process.env.REAL_DESKTOP_TEST === '1' ||
      process.env.REAL_DESKTOP_TEST === 'true';
  }

  /**
   * Test: World State Observable
   * Verify that screen perception can capture world state
   */
  async testWorldStateObservable(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];
    if (!this.requiresRealDesktop) return skipped('World State Observable', startTime, 'Skipped: set REAL_DESKTOP_TEST=1 to inspect the live desktop.');

    try {
      const result = await screenPerception.observeWorld();

      if (!result.success) {
        return {
          name: 'World State Observable',
          passed: false,
          duration: Date.now() - startTime,
          evidence,
          error: result.error || 'Failed to observe world state',
        };
      }

      if (!result.observations || result.observations.length === 0) {
        evidence.push('No observations captured');
        return {
          name: 'World State Observable',
          passed: false,
          status: 'FAILED',
          duration: Date.now() - startTime,
          evidence,
          error: 'Screen perception returned no observable evidence.',
        };
      }

      evidence.push(
        `Captured ${result.observations.length} observations`,
        `Observation types: ${result.observations.map((o) => o.type).join(', ')}`
      );

      return {
        name: 'World State Observable',
        passed: true,
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'World State Observable',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Task Creation and State Management
   */
  async testTaskCreationAndStateManagement(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    try {
      const goal: Goal = {
        id: 'test-goal-1',
        description: 'Test closed-loop task creation',
        priority: 'normal',
        context: {},
        authorityLevel: 'NORMAL',
      };

      const task = closedLoopExecutor.createTask(goal);

      evidence.push(
        `Task created with ID: ${task.id}`,
        `Initial state: ${task.currentState}`,
        `Goal: ${task.goal.description}`
      );

      if (task.currentState !== 'CREATED') {
        return {
          name: 'Task Creation and State Management',
          passed: false,
          duration: Date.now() - startTime,
          evidence,
          error: `Expected CREATED state, got ${task.currentState}`,
        };
      }

      return {
        name: 'Task Creation and State Management',
        passed: true,
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Task Creation and State Management',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Memory Storage and Retrieval
   */
  async testMemoryStorageAndRetrieval(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    try {
      // Create and store episodic memory
      const memory = memoryService.learnFromSuccess(
        'test-task-1',
        'test_type',
        'Test goal',
        'test_strategy',
        5000,
        1,
        0.95
      );

      evidence.push(`Created achievement memory: ${memory.id}`);

      // Retrieve memory
      const result = memoryService.queryMemories({
        type: 'achievement',
      });

      evidence.push(`Retrieved ${result.memories.length} achievement memories`);

      if (result.totalMatches === 0) {
        return {
          name: 'Memory Storage and Retrieval',
          passed: false,
          duration: Date.now() - startTime,
          evidence,
          error: 'No memories found after storage',
        };
      }

      // Get statistics
      const stats = memoryService.getStatistics();
      evidence.push(
        `Total memories: ${stats.total}`,
        `Average confidence: ${(stats.averageConfidence * 100).toFixed(1)}%`
      );

      return {
        name: 'Memory Storage and Retrieval',
        passed: true,
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Memory Storage and Retrieval',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Skill Library and Strategy Manager
   */
  async testSkillAndStrategyManagement(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    try {
      const skills = skillLibrary.getAllSkills();
      evidence.push(`Loaded ${skills.length} built-in skills`);

      if (skills.length === 0) {
        return {
          name: 'Skill Library and Strategy Manager',
          passed: false,
          duration: Date.now() - startTime,
          evidence,
          error: 'No skills loaded',
        };
      }

      // Test skill selection
      const selectedSkill = skillLibrary.selectBestSkill('test_task');
      if (selectedSkill) {
        evidence.push(`Selected skill: ${selectedSkill.name}`);
      }

      // Test strategy manager
      const allMetrics = strategyManager.getAllMetrics();
      evidence.push(`Strategy manager tracking ${allMetrics.length} strategies`);

      return {
        name: 'Skill Library and Strategy Manager',
        passed: true,
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Skill Library and Strategy Manager',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Regression test: unimplemented planning must fail before action dispatch.
   */
  async testClosedLoopExecutionSimulation(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    try {
      const goal: Goal = {
        id: 'test-goal-simulation',
        description: 'Simulate closed-loop execution',
        priority: 'normal',
        context: { simulationMode: true },
        authorityLevel: 'NORMAL',
      };

      const task = closedLoopExecutor.createTask(goal);
      evidence.push(`Created task: ${task.id}`);

      // Execute task (with short timeout for simulation)
      const result = await closedLoopExecutor.executeTask(task.id, {
        maxRetries: 1,
        maxRecoveries: 1,
        maxReplans: 1,
        timeoutMs: 5000,
      });

      evidence.push(
        `Task completed with state: ${result.finalState}`,
        `Total actions executed: ${result.totalActions}`,
        `Total observations captured: ${result.totalObservations}`,
        `Total recoveries attempted: ${result.totalRecoveries}`,
        `Total replans attempted: ${result.totalReplans}`,
        `Execution duration: ${result.duration}ms`
      );

      const refusedSafely = result.finalState === 'FAILED'
        && result.success === false
        && result.totalActions === 0
        && result.totalObservations === 0
        && /planning is not implemented/i.test(result.error || '');
      evidence.push(refusedSafely
        ? 'PASS: unsupported planning was refused before any desktop action.'
        : 'FAIL: executor did not fail closed for an unplannable task.');
      return {
        name: 'Closed-Loop Execution Guard',
        passed: refusedSafely,
        status: refusedSafely ? 'PASSED' : 'FAILED',
        duration: Date.now() - startTime,
        evidence,
        error: refusedSafely ? undefined : (result.error || `Unexpected terminal state: ${result.finalState}`),
      };
    } catch (error) {
      return {
        name: 'Closed-Loop Execution Guard',
        passed: false,
        status: 'FAILED',
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Real Desktop - Mouse Movement
   * Only runs if REAL_DESKTOP_TEST=1
   */
  async testRealDesktopMouseMovement(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    if (!this.requiresRealDesktop) {
      return skipped('Real Desktop - Mouse Movement', startTime, 'Skipped: set REAL_DESKTOP_TEST=1 to move the real mouse.');
    }

    try {
      const before = await callDesktopTool('hardwareMousePosition');
      const x = Number(before?.x);
      const y = Number(before?.y);
      const width = Number(before?.screen_width);
      const height = Number(before?.screen_height);
      if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2) {
        throw new Error('Desktop agent returned invalid cursor/screen coordinates.');
      }

      const targetX = x + 1 < width ? x + 1 : Math.max(0, x - 1);
      const moved = await callDesktopTool('hardwareMouseMove', { x: targetX, y, duration: 0, mode: 'FAST' });
      const restored = await callDesktopTool('hardwareMouseMove', { x, y, duration: 0, mode: 'FAST' });
      const passed = moved?.verified === true && Number(restored?.x) === x && Number(restored?.y) === y;
      evidence.push(
        `Screen dimensions: ${width}x${height}`,
        `Cursor moved from (${x}, ${y}) to (${targetX}, ${y}) and back to (${restored?.x}, ${restored?.y}).`,
      );
      if (!passed) throw new Error('The desktop agent did not verify the cursor movement and restore.');

      return {
        name: 'Real Desktop - Mouse Movement',
        passed: true,
        status: 'PASSED',
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Real Desktop - Mouse Movement',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Real Desktop - Application Control
   */
  async testRealDesktopApplicationControl(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    if (!this.requiresRealDesktop) {
      return skipped('Real Desktop - Application Control', startTime, 'Skipped: set REAL_DESKTOP_TEST=1 to launch Notepad.');
    }

    try {
      const result = await callDesktopTool('openApplication', { name: 'notepad' });
      if (result?.status !== 'SUCCESS' || result?.verified !== true) {
        throw new Error(result?.result || 'Notepad was not verified as open and focused.');
      }
      evidence.push(`Notepad launch verified: ${String(result.result || 'focused window confirmed')}`);
      return {
        name: 'Real Desktop - Application Control',
        passed: true,
        status: 'PASSED',
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Real Desktop - Application Control',
        passed: false,
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    }
  }

  /**
   * Test: Real Desktop - Notepad Save and Verify
   */
  async testRealDesktopNotepadSaveAndVerify(): Promise<TestResult> {
    const startTime = Date.now();
    const evidence: string[] = [];

    if (!this.requiresRealDesktop) {
      return skipped('Real Desktop - Notepad Save and Verify', startTime, 'Skipped: set REAL_DESKTOP_TEST=1 to perform a real Notepad save.');
    }

    const filePath = path.join(os.tmpdir(), `sara-acceptance-${randomUUID()}.txt`);
    const content = `SARA real-desktop acceptance ${randomUUID()}`;
    try {
      fs.writeFileSync(filePath, '', { flag: 'wx' });
      const launched = await callDesktopTool('openApplication', { name: 'notepad' });
      if (launched?.status !== 'SUCCESS' || launched?.verified !== true) {
        throw new Error(launched?.result || 'Notepad was not verified as open and focused.');
      }

      await callDesktopTool('hardwareKeyboardPress', { keys: ['ctrl', 'o'] });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await callDesktopTool('hardwareKeyboardType', { text: filePath });
      await callDesktopTool('hardwareKeyboardPress', { keys: ['enter'] });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await callDesktopTool('hardwareKeyboardType', { text: content });
      await callDesktopTool('hardwareKeyboardPress', { keys: ['ctrl', 's'] });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const saved = fs.readFileSync(filePath, 'utf-8');
      if (saved !== content) {
        throw new Error('Saved file content did not match the typed acceptance marker.');
      }
      evidence.push(`Created, opened, typed, and saved a unique temporary file: ${path.basename(filePath)}`);
      evidence.push('Read-back assertion matched the exact typed content.');
      return {
        name: 'Real Desktop - Notepad Save and Verify',
        passed: true,
        status: 'PASSED',
        duration: Date.now() - startTime,
        evidence,
      };
    } catch (error) {
      return {
        name: 'Real Desktop - Notepad Save and Verify',
        passed: false,
        status: 'FAILED',
        duration: Date.now() - startTime,
        evidence,
        error: String(error),
      };
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* keep the test result; temp directory cleanup is best-effort */ }
    }
  }

  /**
   * Run all tests
   */
  async runAllTests(): Promise<{
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    results: TestResult[];
    duration: number;
  }> {
    const startTime = Date.now();
    this.results = [];

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('SARA CLOSED-LOOP AUTONOMOUS ACCEPTANCE TESTS');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Run tests in sequence
    const tests = [
      () => this.testWorldStateObservable(),
      () => this.testTaskCreationAndStateManagement(),
      () => this.testMemoryStorageAndRetrieval(),
      () => this.testSkillAndStrategyManagement(),
      () => this.testClosedLoopExecutionSimulation(),
      () => this.testRealDesktopMouseMovement(),
      () => this.testRealDesktopApplicationControl(),
      () => this.testRealDesktopNotepadSaveAndVerify(),
    ];

    for (const test of tests) {
      try {
        const result = await test();
        this.results.push(result);
        
        const status = result.status || (result.passed ? 'PASSED' : 'FAILED');
        const marker = status === 'SKIPPED' ? '↷ SKIP' : status === 'PASSED' ? '✓ PASS' : '✗ FAIL';
        console.log(`${marker}: ${result.name} (${result.duration}ms)`);
        
        if (result.evidence.length > 0) {
          result.evidence.forEach((e) => console.log(`  → ${e}`));
        }
        
        if (result.error) {
          console.log(`  Error: ${result.error}`);
        }
        console.log();
      } catch (error) {
        const failure: TestResult = {
          name: `Acceptance test ${this.results.length + 1}`,
          passed: false,
          status: 'FAILED',
          duration: 0,
          evidence: [],
          error: String(error),
        };
        this.results.push(failure);
        console.log(`✗ ERROR: ${failure.error}`);
        console.log();
      }
    }

    const duration = Date.now() - startTime;
    const passed = this.results.filter((result) => (result.status || (result.passed ? 'PASSED' : 'FAILED')) === 'PASSED').length;
    const skippedCount = this.results.filter((result) => result.status === 'SKIPPED').length;
    const failed = this.results.length - passed - skippedCount;

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skippedCount} skipped (${this.results.length} total)`);
    console.log(`Total duration: ${duration}ms`);
    console.log('═══════════════════════════════════════════════════════════\n');

    return {
      total: this.results.length,
      passed,
      failed,
      skipped: skippedCount,
      results: this.results,
      duration,
    };
  }
}

/**
 * Main execution
 */
async function main() {
  const tester = new ClosedLoopAutonomousAcceptanceTests();
  const results = await tester.runAllTests();

  if (results.failed > 0) {
    process.exit(1);
  }
}

// Run main if this is the entry point
const runMain = process.argv[1]?.endsWith('closed-loop-acceptance.ts');
if (runMain) {
  void main();
}
