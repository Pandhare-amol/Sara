import { SelfImprovementManager } from "../self_improvement/SelfImprovementManager";
import { IntrospectionResult } from "./types";
import { EventBus } from "../core/events/EventBus";
import { CodeGenerationService } from "../self_improvement/CodeGenerationService";
import { getEpisodicMemory } from "../cognitive/episodicMemory";

export class RecursiveSelfImprovementLoop {
  private baseManager: SelfImprovementManager;
  private codeGenService: CodeGenerationService;
  private intervalMs: number = 24 * 60 * 60 * 1000; // start at 24 hours
  private successfulImprovements: number = 0;
  private intervalTimer: NodeJS.Timeout | null = null;
  private logs: IntrospectionResult[] = [];

  constructor(baseManager: SelfImprovementManager, apiKey: string) {
    this.baseManager = baseManager;
    this.codeGenService = new CodeGenerationService(apiKey);
  }

  start() {
    this.scheduleNextCycle();
  }

  stop() {
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
  }

  private scheduleNextCycle() {
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
    this.intervalTimer = setTimeout(async () => {
      await this.triggerIntrospectionCycle();
      this.scheduleNextCycle();
    }, this.intervalMs);
  }

  async triggerIntrospectionCycle(): Promise<IntrospectionResult> {
    const startTime = Date.now();
    const episodicMemory = getEpisodicMemory();

    // 1. Profile recent tasks
    const recentFailedTasks = episodicMemory.getFailed(10);
    const bottlenecks = recentFailedTasks.map(task => {
      const mode = task.lesson.failureModes?.[0] || 'unknown error';
      return `Task: ${task.title}, Failure: ${mode}`;
    });

    // 2. Identify reasoning bottlenecks
    let patchesProposed = 0;
    if (bottlenecks.length > 0) {
      // Simulate generating a patch for the biggest bottleneck
      const prompt = `Identify a fix for these bottlenecks and generate the code patch: \n${bottlenecks.join('\n')}`;
      try {
        const suggestedCode = await this.codeGenService.generateCode(prompt);
        patchesProposed = 1;

        // Emitting patch suggestion with forced confirmation for safety
        EventBus.instance.emitEvent("asiPatchSuggestion", {
          code: suggestedCode,
          requiresConfirmation: true, // ALWAYS require confirmation for self-code
          autonomyTier: 'confirm'
        });
      } catch (e) {
        console.error("Code generation failed during introspection", e);
      }
    }

    const durationMs = Date.now() - startTime;
    const result: IntrospectionResult = {
      cycleId: `intro-${Date.now()}`,
      bottlenecksIdentified: bottlenecks,
      patchesProposed,
      durationMs,
      timestamp: Date.now()
    };

    this.logs.unshift(result);
    if (this.logs.length > 50) this.logs.pop(); // keep last 50 logs

    EventBus.instance.emitEvent("selfImprovementCycle", result);
    return result;
  }

  getLogs(): IntrospectionResult[] {
    return this.logs;
  }

  recordSuccessfulImprovement() {
    this.successfulImprovements++;
    // Exponential scheduling
    if (this.successfulImprovements >= 3) {
      this.intervalMs = Math.max(1000 * 60 * 60, this.intervalMs / 2); // Halve the interval, min 1 hour
      this.scheduleNextCycle();
      this.successfulImprovements = 0; // reset counter for next tier
    }
  }
}
