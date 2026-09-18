import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SelfImprovementEngine } from '../src/self_improvement/SelfImprovementEngine';
import { AutoFixEngine } from '../src/self_improvement/AutoFixEngine';

test('SelfImprovementEngine flags critical runtime health when memory and lag spike', () => {
  const engine = new SelfImprovementEngine({
    memoryThresholdMb: 250,
    cpuThresholdPercent: 80,
    eventLoopLagThresholdMs: 40,
    healthCheckIntervalMs: 5000,
  });

  const report = engine.analyze({
    memoryUsageMb: 420,
    cpuUsagePercent: 93,
    eventLoopLagMs: 81,
    warnings: ['memory_pressure', 'event_loop_lag'],
  });

  assert.equal(report.status, 'critical');
  assert.ok(report.recommendations.some((item) => item.toLowerCase().includes('reduce') || item.toLowerCase().includes('optimize')));
});

test('AutoFixEngine rewrites a broken import path to the correct runtime location', () => {
  const engine = new AutoFixEngine();
  const fixed = engine.applyTextFix(
    "import { EventBus } from '../events/EventBus';\n",
    {
      kind: 'import-path',
      target: '../events/EventBus',
      replacement: '../core/events/EventBus',
    },
  );

  assert.match(fixed, /\.\.\/core\/events\/EventBus/);
});

test('PatchReviewEngine approves safe runtime patches and rejects dangerous file destruction', async () => {
  const { PatchReviewEngine } = await import('../src/self_improvement/PatchReviewEngine');
  const engine = new PatchReviewEngine();

  const safe = engine.review({
    issue: 'Cannot find module ../events/EventBus',
    filePath: 'src/self_improvement/PerformanceMonitor.ts',
    patch: "import { EventBus } from '../core/events/EventBus';\n",
  });

  assert.equal(safe.status, 'approve');

  const dangerous = engine.review({
    issue: 'Cleanup failed because a delete operation is required',
    filePath: 'src/important.ts',
    patch: 'rm -rf /',
  });

  assert.equal(dangerous.status, 'reject');
  assert.ok(dangerous.reason.toLowerCase().includes('dangerous') || dangerous.reason.toLowerCase().includes('unsafe'));
});

test('PatchExecutionEngine applies an approved patch only inside the project root and verifies the result', async () => {
  const { PatchExecutionEngine } = await import('../src/self_improvement/PatchExecutionEngine');
  const engine = new PatchExecutionEngine({ projectRoot: process.cwd() });
  const tempPath = 'tmp/self-healing-test.txt';
  const absolutePath = path.resolve(process.cwd(), tempPath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, 'hello\n', 'utf8');

  const result = await engine.execute({
    filePath: tempPath,
    issue: 'Missing log line for startup',
    patch: 'hello\nready\n',
    verification: async (content) => content.includes('ready'),
  });

  assert.equal(result.status, 'applied');
  assert.ok((await fs.readFile(absolutePath, 'utf8')).includes('ready'));

  await fs.rm(path.dirname(absolutePath), { recursive: true, force: true });
});

test('SelfMaintenanceOrchestrator runs review, execution, and verification in a single safe loop', async () => {
  const { SelfMaintenanceOrchestrator } = await import('../src/self_improvement/SelfMaintenanceOrchestrator');
  const tempPath = 'tmp/orchestrator-self-heal.txt';
  const absolutePath = path.resolve(process.cwd(), tempPath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, 'start\n', 'utf8');

  const orchestrator = new SelfMaintenanceOrchestrator({ projectRoot: process.cwd() });
  const result = await orchestrator.run({
    filePath: tempPath,
    issue: 'Need startup marker',
    patch: 'start\nready\n',
    verification: async (content) => content.includes('ready'),
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.reviewStatus, 'approve');
  assert.equal(result.verified, true);
  assert.ok((await fs.readFile(absolutePath, 'utf8')).includes('ready'));

  await fs.rm(path.dirname(absolutePath), { recursive: true, force: true });
});

test('SelfHealingLoop records a health report when SARA enters warning or critical state', async () => {
  const { SelfHealingLoop } = await import('../src/self_improvement/SelfHealingLoop');
  const loop = new SelfHealingLoop({
    projectRoot: process.cwd(),
    reportDir: 'tmp/self-healing-loop',
    intervalMs: 0,
  });

  const result = await loop.runOnce({
    memoryUsageMb: 420,
    cpuUsagePercent: 91,
    eventLoopLagMs: 82,
    warnings: ['memory_pressure', 'event_loop_lag'],
  });

  assert.equal(result.status, 'critical');
  assert.ok(result.reportPath.includes('self-healing'));

  await fs.rm(path.resolve(process.cwd(), 'tmp/self-healing-loop'), { recursive: true, force: true });
});

test('runtime health controller triggers maintenance for degraded live runtime', async () => {
  const { evaluateRuntimeHealth } = await import('../src/self_improvement/runtimeHealthController');

  const result = await evaluateRuntimeHealth({
    projectRoot: process.cwd(),
    reportDir: 'tmp/self-healing-live',
    snapshot: {
      memoryUsageMb: 420,
      cpuUsagePercent: 91,
      eventLoopLagMs: 82,
      warnings: ['memory_pressure', 'event_loop_lag'],
    },
  });

  assert.equal(result.status, 'critical');
  assert.equal(result.maintenanceTriggered, true);
  assert.ok(result.reportPath.includes('self-healing-live'));

  await fs.rm(path.resolve(process.cwd(), 'tmp/self-healing-live'), { recursive: true, force: true });
});

test('runtime health monitor suppresses repeated maintenance during cooldown', async () => {
  const { createRuntimeHealthMonitor } = await import('../src/self_improvement/runtimeHealthController');
  let maintenanceCount = 0;
  const monitor = createRuntimeHealthMonitor({
    projectRoot: process.cwd(),
    reportDir: 'tmp/self-healing-monitor',
    intervalMs: 60_000,
    cooldownMs: 60_000,
    getSnapshot: () => ({
      memoryUsageMb: 420,
      cpuUsagePercent: 91,
      eventLoopLagMs: 82,
      warnings: ['memory_pressure', 'event_loop_lag'],
    }),
    onMaintenance: () => { maintenanceCount += 1; },
  });

  const first = await monitor.checkNow();
  const second = await monitor.checkNow();

  assert.equal(first.maintenanceTriggered, true);
  assert.equal(second.maintenanceTriggered, false);
  assert.equal(maintenanceCount, 1);

  await fs.rm(path.resolve(process.cwd(), 'tmp/self-healing-monitor'), { recursive: true, force: true });
});
