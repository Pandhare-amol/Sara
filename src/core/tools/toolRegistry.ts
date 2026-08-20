import type { CanonicalToolResult } from "../contracts/toolContract";

export type ToolOwner = "desktop-agent" | "node" | "renderer";

export interface ToolRouteDefinition {
  name: string;
  owner: ToolOwner;
  category?: string;
  requiresConfirmation?: boolean;
  idempotent?: boolean;
}

/**
 * Small compatibility registry. Existing Python registration remains
 * authoritative; this registry describes the Node routing boundary only.
 */
export class ToolRegistry {
  private readonly routes = new Map<string, ToolRouteDefinition>();

  register(definition: ToolRouteDefinition): void {
    this.routes.set(definition.name, { ...definition });
  }

  registerMany(definitions: Iterable<ToolRouteDefinition>): void {
    for (const definition of definitions) this.register(definition);
  }

  get(name: string): ToolRouteDefinition | undefined {
    return this.routes.get(name);
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  list(): ToolRouteDefinition[] {
    return Array.from(this.routes.values());
  }
}

export type ToolExecutionAdapter = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export type RoutedToolResult = Awaited<ReturnType<ToolExecutionAdapter>> & {
  route?: ToolRouteDefinition;
  canonical?: CanonicalToolResult;
};
