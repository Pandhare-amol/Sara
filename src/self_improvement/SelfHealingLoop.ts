import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SelfImprovementEngine } from './SelfImprovementEngine';
import { SelfMaintenanceOrchestrator } from './SelfMaintenanceOrchestrator';

export interface SelfHealingLoopOptions {
  projectRoot: string;
  reportDir: string;
  intervalMs?: number;
}

export interface RuntimeHealthSample {
  memoryUsageMb: number;
  cpuUsagePercent: number;
  eventLoopLagMs: number;
  warnings?: string[];
}

export interface SelfHealingLoopResult {
  status: 'healthy' | 'warning' | 'critical';
  reportPath: string;
  recommendations: string[];
  maintenanceTriggered: boolean;
}

export class SelfHealingLoop {
  private readonly engine: SelfImprovementEngine;
  private readonly orchestrator: SelfMaintenanceOrchestrator;
  private readonly reportDir: string;

  constructor(options: SelfHealingLoopOptions) {
    this.engine = new SelfImprovementEngine({
      memoryThresholdMb: 512,
      cpuThresholdPercent: 85,
      eventLoopLagThresholdMs: 75,
      healthCheckIntervalMs: options.intervalMs ?? 5000,
    });
    this.orchestrator = new SelfMaintenanceOrchestrator({ projectRoot: options.projectRoot });
    this.reportDir = path.resolve(options.projectRoot, options.reportDir);
  }

  public async runOnce(sample: RuntimeHealthSample): Promise<SelfHealingLoopResult> {
    const report = this.engine.analyze(sample);
    const reportPath = path.join(this.reportDir, `health-${Date.now()}.json`);

    await fs.mkdir(this.reportDir, { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      ...sample,
      status: report.status,
      recommendations: report.recommendations,
    }, null, 2), 'utf8');

    const maintenanceTriggered = report.status !== 'healthy';
    if (maintenanceTriggered) {
      const maintenance = await this.orchestrator.run({
        filePath: 'tmp/maintenance-log.txt',
        issue: `Runtime health degraded to ${report.status}`,
        patch: `runtime_status=${report.status}\nrecommended_actions=${report.recommendations.join('; ')}\n`,
        verification: async (content) => content.includes(report.status) || content.includes('recommended_actions'),
      });
      if (maintenance.status === 'applied') {
        report.recommendations.push(`Maintenance patch applied: ${maintenance.details}`);
      }
    }

    return {
      status: report.status,
      reportPath,
      recommendations: report.recommendations,
      maintenanceTriggered,
    };
  }
}
