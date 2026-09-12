import { ToolRegistry, type ToolExecutionAdapter, type RoutedToolResult } from "./toolRegistry";
import { normalizeToolExecutionResult } from "./toolExecutor";
import { ToolPolicyEngine, type PolicyContext } from "./policyEngine";

export interface ToolRouterOptions {
  registry?: ToolRegistry;
  isKnownTool?: (tool: string) => boolean;
}

/** Routes existing tool names to their current owner without reimplementing tools. */
export class ToolRouter {
  public readonly registry: ToolRegistry;
  public readonly policyEngine: ToolPolicyEngine;
  private readonly isKnownTool?: (tool: string) => boolean;
  private adapter: ToolExecutionAdapter | null = null;

  constructor(options: ToolRouterOptions = {}) {
    this.registry = options.registry || new ToolRegistry();
    this.policyEngine = new ToolPolicyEngine();
    this.isKnownTool = options.isKnownTool;
  }

  setAdapter(adapter: ToolExecutionAdapter): void {
    this.adapter = adapter;
  }

  ensureToolRegistered(tool: string): boolean {
    if (this.registry.has(tool)) {
      return true;
    }

    const knownTool = this.isKnownTool ? this.isKnownTool(tool) : false;
    if (!knownTool) {
      return false;
    }

    this.registry.register({
      name: tool,
      owner: "node",
      category: "RUNTIME",
      metadata: {
        riskLevel: "READ_ONLY",
        requiresConfirmation: false,
        supportsCancellation: true,
        supportsRetry: true,
        retryPolicy: { supportsRetry: true, maxAttempts: 2 },
        timeoutMs: 25000,
        version: "1.0",
        idempotent: true,
      },
    });

    return this.registry.has(tool);
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<RoutedToolResult> {
    const knownTool = this.ensureToolRegistered(tool);
    let route = this.registry.get(tool);

    if (!route && !knownTool) {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "FAILED",
        execution_status: "FAILED",
        verification_status: "SKIPPED",
        message: `Tool '${tool}' is not available through the current runtime registry.`,
        executed: false,
      }, `Tool '${tool}' is not available through the current runtime registry.`);
      return { ok: false, result: canonical, error: canonical.message, canonical };
    }

    // Policy middleware enforcement
    // For now we extract any confirmation token from args or context
    const policyCtx: PolicyContext = {
      confirmed: args.user_confirmed === true || args.policy_override === true
    };
    const policyOutcome = this.policyEngine.evaluate(tool, args, this.registry, policyCtx);
    
    if (policyOutcome.decision === "DENY") {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "FAILED",
        execution_status: "FAILED",
        verification_status: "SKIPPED",
        message: `Policy blocked execution: ${policyOutcome.reason}`,
        executed: false,
        policy_decision: "DENY"
      }, `Policy blocked execution: ${policyOutcome.reason}`);
      return { ok: false, result: canonical, error: canonical.message, canonical };
    }
    
    if (policyOutcome.decision === "ASK_USER") {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "UNCERTAIN",
        execution_status: "SKIPPED",
        verification_status: "NOT_REQUIRED",
        message: `Waiting for user approval: ${policyOutcome.reason}`,
        executed: false,
        policy_decision: "ASK_USER"
      });
      // A special return shape to tell the orchestrator it needs approval
      return { ok: false, result: canonical, error: "WAITING_FOR_APPROVAL", canonical };
    }

    if (!this.adapter) {
      throw new Error("Tool Router execution adapter is not configured.");
    }

    const response = await this.adapter(tool, args);
    const canonical = normalizeToolExecutionResult(tool, response.result, response.error);
    return { ...response, route, canonical, result: canonical };
  }
}
