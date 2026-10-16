import { ToolRegistry, type ToolExecutionAdapter, type RoutedToolResult } from "./toolRegistry";
import { normalizeToolExecutionResult } from "./toolExecutor";
import { ToolPolicyEngine, type PolicyContext } from "./policyEngine";

export interface ToolRouterOptions {
  registry?: ToolRegistry;
  isKnownTool?: (tool: string) => boolean;
}

const UNTRUSTED_APPROVAL_FIELDS = new Set(["confirmed", "authorized", "user_confirmed", "policy_override"]);

/** Remove consent-shaped fields supplied as tool input; trusted approval is added separately. */
export function sanitizeToolApprovalClaims(
  args: Record<string, unknown>,
  policyContext: PolicyContext = {},
): Record<string, unknown> {
  const sanitized = Object.fromEntries(
    Object.entries(args).filter(([key]) => !UNTRUSTED_APPROVAL_FIELDS.has(key.toLowerCase())),
  );
  if (policyContext.authorized === true || policyContext.confirmed === true) sanitized.confirmed = true;
  return sanitized;
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

  async execute(tool: string, args: Record<string, unknown>, policyContext: PolicyContext = {}): Promise<RoutedToolResult> {
    const knownTool = this.ensureToolRegistered(tool);
    const route = this.registry.get(tool);

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

    // Consent is accepted only from trusted internal policy context, never from tool input.
    const policyOutcome = this.policyEngine.evaluate(tool, args, this.registry, policyContext);

    if (policyOutcome.decision === "DENY") {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "FAILED",
        execution_status: "FAILED",
        verification_status: "SKIPPED",
        message: `Policy blocked execution: ${policyOutcome.reason}`,
        executed: false,
        policy_decision: "DENY",
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
        policy_decision: "ASK_USER",
      });
      return { ok: false, result: canonical, error: "WAITING_FOR_APPROVAL", canonical };
    }

    if (!this.adapter) {
      throw new Error("Tool Router execution adapter is not configured.");
    }

    const response = await this.adapter(tool, sanitizeToolApprovalClaims(args, policyContext));
    const canonical = normalizeToolExecutionResult(tool, response.result, response.error);
    return { ...response, route, canonical, result: canonical };
  }
}
