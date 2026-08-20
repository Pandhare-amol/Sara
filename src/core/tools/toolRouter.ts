import { ToolRegistry, type ToolExecutionAdapter, type RoutedToolResult } from "./toolRegistry";
import { normalizeToolExecutionResult } from "./toolExecutor";

export interface ToolRouterOptions {
  registry?: ToolRegistry;
  isKnownTool?: (tool: string) => boolean;
}

/** Routes existing tool names to their current owner without reimplementing tools. */
export class ToolRouter {
  public readonly registry: ToolRegistry;
  private readonly isKnownTool?: (tool: string) => boolean;
  private adapter: ToolExecutionAdapter | null = null;

  constructor(options: ToolRouterOptions = {}) {
    this.registry = options.registry || new ToolRegistry();
    this.isKnownTool = options.isKnownTool;
  }

  setAdapter(adapter: ToolExecutionAdapter): void {
    this.adapter = adapter;
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<RoutedToolResult> {
    const route = this.registry.get(tool);
    if (!route && this.isKnownTool && !this.isKnownTool(tool)) {
      const canonical = normalizeToolExecutionResult(tool, {
        status: "FAILED",
        execution_status: "FAILED",
        verification_status: "SKIPPED",
        message: `Tool '${tool}' is not available through the current runtime registry.`,
        executed: false,
      }, `Tool '${tool}' is not available through the current runtime registry.`);
      return { ok: false, result: canonical, error: canonical.message, canonical };
    }

    if (!this.adapter) {
      throw new Error("Tool Router execution adapter is not configured.");
    }

    const response = await this.adapter(tool, args);
    const canonical = normalizeToolExecutionResult(tool, response.result, response.error);
    return { ...response, route, canonical, result: canonical };
  }
}
