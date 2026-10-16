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

    // Never classify a dynamically discovered tool as read-only. Use the
    // registry's conservative name-based risk inference until an owner supplies
    // explicit metadata (the runtime allowlist alone is not a permission grant).
    this.registry.register({ name: tool, owner: "node", category: "RUNTIME" });

    return this.registry.has(tool);
  }

  async execute(tool: string, args: Record<string, unknown>, policyContext: PolicyContext = {}): Promise<RoutedToolResult> {
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

    // Approval must come from the server's trusted policy context, never from
    // model/client-supplied tool arguments. The second check protects direct
    // callers of ToolRouter as well as callers of ExecutionOrchestrator.
    const policyOutcome = this.policyEngine.evaluate(tool, args, this.registry, policyContext);
    
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

    // Strip pseudo-authorization fields before forwarding to the Python agent.
    // Only the backend may set a trusted policyContext; forwarding these fields
    // would let a lower layer independently mistake model output for consent.
    const { confirmed, user_confirmed, policy_override, authorized, ...safeArgs } = args;
    const response = await this.adapter(tool, safeArgs);
    const canonical = normalizeToolExecutionResult(tool, response.result, response.error);
    return { ...response, route, canonical, result: canonical };
  }
}
