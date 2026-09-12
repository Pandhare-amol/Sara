import type { AgentKind, AgentResult, AgentRuntime, AgentTask } from "./advanced-types";

export type AgentHandler = (task: AgentTask) => Promise<{ output: unknown; confidence?: number; evidence?: string[] }>;

export class AutonomousAgentRuntime implements AgentRuntime {
  private readonly handlers = new Map<AgentKind, AgentHandler>();
  register(kind: AgentKind, handler: AgentHandler): void { this.handlers.set(kind, handler); }
  async run(task: AgentTask): Promise<AgentResult> {
    const handler = this.handlers.get(task.kind);
    if (!handler) throw new Error(`No handler registered for ${task.kind} agent.`);
    const started = Date.now();
    const result = await Promise.race([
      handler(task),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Agent '${task.kind}' exceeded its time budget.`)), task.budgetMs ?? 30_000)),
    ]);
    return { taskId: task.id, kind: task.kind, output: result.output, confidence: result.confidence ?? 0.5, evidence: result.evidence ?? [], completedAt: started };
  }
}

export function createSafeAgentRuntime(handlers: Partial<Record<AgentKind, AgentHandler>>): AutonomousAgentRuntime {
  const runtime = new AutonomousAgentRuntime();
  for (const [kind, handler] of Object.entries(handlers)) if (handler) runtime.register(kind as AgentKind, handler);
  return runtime;
}
