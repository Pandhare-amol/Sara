import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SelfHealingLoop, type RuntimeHealthSample } from './SelfHealingLoop';

export interface RuntimeHealthControllerOptions {
  projectRoot: string;
  reportDir: string;
  snapshot: RuntimeHealthSample;
}

export interface RuntimeHealthControllerResult {
  status: 'healthy' | 'warning' | 'critical';
  reportPath: string;
  recommendations: string[];
  maintenanceTriggered: boolean;
}

export interface RuntimeHealthMonitorOptions {
  projectRoot: string;
  reportDir: string;
  intervalMs: number;
  cooldownMs?: number;
  getSnapshot: () => RuntimeHealthSample;
  onMaintenance?: (result: RuntimeHealthControllerResult) => void | Promise<void>;
}

export interface RuntimeHealthMonitor {
  checkNow(): Promise<RuntimeHealthControllerResult>;
  start(): void;
  stop(): void;
}

export async function evaluateRuntimeHealth(options: RuntimeHealthControllerOptions): Promise<RuntimeHealthControllerResult> {
  const loop = new SelfHealingLoop({
    projectRoot: options.projectRoot,
    reportDir: options.reportDir,
    intervalMs: 0,
  });

  return loop.runOnce(options.snapshot);
}

export function createRuntimeHealthMonitor(options: RuntimeHealthMonitorOptions): RuntimeHealthMonitor {
  let timer: NodeJS.Timeout | null = null;
  let previousStatus: RuntimeHealthControllerResult['status'] = 'healthy';
  let lastMaintenanceAt = 0;
  let inFlight: Promise<RuntimeHealthControllerResult> | null = null;
  const cooldownMs = options.cooldownMs ?? 60_000;

  const checkNow = async (): Promise<RuntimeHealthControllerResult> => {
    if (inFlight) return inFlight;

    const snapshot = options.getSnapshot();
    const { SelfImprovementEngine } = await import('./SelfImprovementEngine');
    const engine = new SelfImprovementEngine({
      memoryThresholdMb: 512,
      cpuThresholdPercent: 85,
      eventLoopLagThresholdMs: 75,
    });
    const status = engine.analyze(snapshot).status;
    const transitionedIntoDegradedState = status !== 'healthy' && previousStatus === 'healthy';
    const cooldownElapsed = Date.now() - lastMaintenanceAt >= cooldownMs;

    if (!transitionedIntoDegradedState && !(status !== 'healthy' && cooldownElapsed)) {
      previousStatus = status;
      return {
        status,
        reportPath: '',
        recommendations: engine.analyze(snapshot).recommendations,
        maintenanceTriggered: false,
      };
    }

    inFlight = evaluateRuntimeHealth({
      projectRoot: options.projectRoot,
      reportDir: options.reportDir,
      snapshot,
    }).then(async (result) => {
      previousStatus = result.status;
      if (result.maintenanceTriggered) {
        lastMaintenanceAt = Date.now();
        await options.onMaintenance?.(result);
      }
      return result;
    }).finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  return {
    checkNow,
    start: () => {
      if (!timer) timer = setInterval(() => { void checkNow(); }, options.intervalMs);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export async function writeRuntimeHealthReport(projectRoot: string, reportDir: string, payload: Record<string, unknown>): Promise<string> {
  const dir = path.resolve(projectRoot, reportDir);
  await fs.mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, `health-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8');
  return reportPath;
}
