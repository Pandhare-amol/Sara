import type { CanonicalToolResult } from "../contracts/toolContract";

export type ToolOwner = "desktop-agent" | "node" | "renderer";
export type ToolRiskLevel = "READ_ONLY" | "REVERSIBLE_WRITE" | "EXTERNAL_SIDE_EFFECT" | "DESTRUCTIVE_SYSTEM";

export interface ToolRetryPolicy {
  supportsRetry: boolean;
  maxAttempts: number;
  retryableErrors?: string[];
}

export interface ToolMetadata {
  category: string;
  description?: string;
  riskLevel: ToolRiskLevel;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiresConfirmation: boolean;
  supportsCancellation: boolean;
  supportsRetry: boolean;
  retryPolicy: ToolRetryPolicy;
  timeoutMs: number;
  verificationMethod?: string;
  requiredPermissions?: string[];
  allowedContexts?: string[];
  version: string;
  idempotent: boolean;
}

export interface ToolRouteDefinition {
  name: string;
  owner: ToolOwner;
  metadata?: Partial<ToolMetadata>;
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
  private readonly metadata = new Map<string, ToolMetadata>();

  register(definition: ToolRouteDefinition): void {
    this.routes.set(definition.name, { ...definition });
    this.metadata.set(definition.name, mergeToolMetadata(definition.name, definition));
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

  getMetadata(name: string): ToolMetadata | undefined {
    return this.metadata.get(name);
  }

  listMetadata(): Array<{ name: string; metadata: ToolMetadata }> {
    return Array.from(this.metadata.entries()).map(([name, metadata]) => ({ name, metadata: { ...metadata } }));
  }

  /** Seed descriptions for runtime tools owned by the existing Desktop Agent. */
  registerRuntimeTools(names: Iterable<string>, defaults: Partial<ToolMetadata> = {}): void {
    for (const name of names) {
      if (this.routes.has(name)) continue;
      this.register({ name, owner: "desktop-agent", metadata: defaults });
    }
  }
}

const DEFAULT_RETRYABLE_ERRORS = ["TIMEOUT", "NETWORK", "UNAVAILABLE", "BROWSER_TIMEOUT"];

function inferRiskLevel(name: string): ToolRiskLevel {
  const value = name.toLowerCase();
  if (/(shutdown|restart|power|delete|closeall|permanent|credentialremove)/.test(value)) return "DESTRUCTIVE_SYSTEM";
  if (/(send|reply|upload|submit|purchase|email|whatsapp)/.test(value)) return "EXTERNAL_SIDE_EFFECT";
  if (/(create|write|copy|move|rename|save|fill|type|volume|brightness|open|launch)/.test(value)) return "REVERSIBLE_WRITE";
  return "READ_ONLY";
}

function inferCategory(name: string): string {
  const value = name.toLowerCase();
  if (value.includes("youtube") || value.includes("media")) return "YOUTUBE";
  if (value.includes("browser") || value.includes("website") || value.includes("search")) return "BROWSER";
  if (value.includes("file") || value.includes("folder") || value.includes("path")) return "FILE";
  if (value.includes("window") || value.includes("application")) return "WINDOW";
  if (value.includes("mouse")) return "MOUSE";
  if (value.includes("keyboard") || value.includes("key")) return "KEYBOARD";
  if (value.includes("screen") || value.includes("screenshot") || value.includes("vision")) return "SCREEN";
  if (value.includes("memory") || value.includes("rag") || value.includes("knowledge")) return "MEMORY";
  if (value.includes("whatsapp") || value.includes("email") || value.includes("message")) return "MESSAGING";
  if (value.includes("clipboard")) return "CLIPBOARD";
  if (value.includes("task") || value.includes("agent")) return "TASK";
  return "SYSTEM";
}

function mergeToolMetadata(name: string, definition: ToolRouteDefinition): ToolMetadata {
  const supplied = definition.metadata || {};
  const riskLevel = supplied.riskLevel || inferRiskLevel(name);
  const supportsRetry = supplied.supportsRetry ?? !["EXTERNAL_SIDE_EFFECT", "DESTRUCTIVE_SYSTEM"].includes(riskLevel);
  return {
    category: supplied.category || definition.category || inferCategory(name),
    description: supplied.description,
    riskLevel,
    inputSchema: supplied.inputSchema,
    outputSchema: supplied.outputSchema,
    requiresConfirmation: supplied.requiresConfirmation ?? definition.requiresConfirmation ?? riskLevel === "DESTRUCTIVE_SYSTEM",
    supportsCancellation: supplied.supportsCancellation ?? false,
    supportsRetry,
    retryPolicy: supplied.retryPolicy || { supportsRetry, maxAttempts: supportsRetry ? 2 : 1, retryableErrors: DEFAULT_RETRYABLE_ERRORS },
    timeoutMs: supplied.timeoutMs ?? 25000,
    verificationMethod: supplied.verificationMethod,
    requiredPermissions: supplied.requiredPermissions || [],
    allowedContexts: supplied.allowedContexts || ["voice", "chat", "task", "api"],
    version: supplied.version || "1.0",
    idempotent: supplied.idempotent ?? definition.idempotent ?? riskLevel === "READ_ONLY",
  };
}

export type ToolExecutionAdapter = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export type RoutedToolResult = Awaited<ReturnType<ToolExecutionAdapter>> & {
  route?: ToolRouteDefinition;
  canonical?: CanonicalToolResult;
};
