import { ToolRegistry, type ToolExecutionAdapter, type RoutedToolResult } from "./toolRegistry";
import { normalizeToolExecutionResult } from "./toolExecutor";
import { ToolPolicyEngine, type PolicyContext } from "./policyEngine";
import { PermissionManager } from "../permissions/PermissionManager";

export type { RoutedToolResult } from "./toolRegistry";

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

    // Permission check via PermissionManager
    const userId = typeof args.userId === "string" ? args.userId : undefined;
    const permResult = await PermissionManager.instance.requestPermission(tool, { userId });
    if (!permResult.granted) {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "FAILED",
        execution_status: "FAILED",
        verification_status: "SKIPPED",
        message: `Permission denied: ${permResult.reason || "No reason provided"}`,
        executed: false,
        policy_decision: "DENY",
      }, `Permission denied: ${permResult.reason || "No reason"}`);
      return { ok: false, result: canonical, error: canonical.message, canonical };
    }

    if (!this.adapter) {
      throw new Error("Tool Router execution adapter is not configured.");
    }

    const response = await this.adapter(tool, args);
    // If the adapter already returns a Python-computed canonical (has execution_status
    // or verification shape), skip re-normalizing to avoid clobbering Python evidence.
    const rawResult = response.result;
    const isPythonCanonical =
      rawResult &&
      typeof rawResult === "object" &&
      ("execution_status" in (rawResult as object) || "verification" in (rawResult as object));
    const canonical = isPythonCanonical
      ? normalizeToolExecutionResult(tool, rawResult) // will spread and preserve fields
      : normalizeToolExecutionResult(tool, rawResult, response.error);
    return { ...response, route, canonical, result: canonical };
  }
}
