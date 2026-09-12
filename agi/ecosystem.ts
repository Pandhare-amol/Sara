import type { AgiGenerationRequest, AgiGenerationResult } from "./types";

export interface ApiRequest { method: string; path: string; apiKey?: string; userId?: string; body?: unknown; correlationId?: string; }
export interface ApiResponse { status: number; body: unknown; headers?: Record<string, string>; }
export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;

export class ApiGateway {
  private readonly routes = new Map<string, ApiHandler>();
  private readonly usage = new Map<string, { requests: number; lastRequestAt: number }>();
  constructor(private readonly version = "v1", private readonly requestsPerMinute = 60) {}
  register(method: string, path: string, handler: ApiHandler): void { this.routes.set(`${method.toUpperCase()} /api/${this.version}${path}`, handler); }
  async handle(request: ApiRequest): Promise<ApiResponse> {
    const key = request.apiKey ?? request.userId ?? "anonymous";
    const now = Date.now();
    const usage = this.usage.get(key) ?? { requests: 0, lastRequestAt: now };
    if (now - usage.lastRequestAt >= 60_000) { usage.requests = 0; usage.lastRequestAt = now; }
    if (++usage.requests > this.requestsPerMinute) return { status: 429, body: { error: "Rate limit exceeded", correlationId: request.correlationId } };
    this.usage.set(key, usage);
    const handler = this.routes.get(`${request.method.toUpperCase()} ${request.path.startsWith("/api/") ? request.path : `/api/${this.version}${request.path}`}`);
    return handler ? handler(request) : { status: 404, body: { error: "Route not found", correlationId: request.correlationId } };
  }
  usageSnapshot(): Array<{ key: string; requests: number }> { return [...this.usage.entries()].map(([key, value]) => ({ key, requests: value.requests })); }
}

export interface QueueJob<T> { id: string; payload: T; priority: number; attempts: number; status: "queued" | "running" | "completed" | "failed"; error?: string; }
export class PriorityJobQueue<T> {
  private readonly jobs = new Map<string, QueueJob<T>>();
  private running = false;
  constructor(private readonly concurrency = 1, private readonly maxAttempts = 3) {}
  enqueue(payload: T, priority = 0): QueueJob<T> { const job = { id: crypto.randomUUID(), payload, priority, attempts: 0, status: "queued" as const }; this.jobs.set(job.id, job); return job; }
  status(id: string): QueueJob<T> | undefined { const job = this.jobs.get(id); return job && { ...job }; }
  async process(handler: (payload: T, job: QueueJob<T>) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = [...this.jobs.values()].filter((job) => job.status === "queued").sort((a, b) => b.priority - a.priority);
      for (const job of pending.slice(0, this.concurrency)) {
        job.status = "running"; job.attempts++;
        try { await handler(job.payload, job); job.status = "completed"; } catch (error) { job.error = error instanceof Error ? error.message : String(error); job.status = job.attempts < this.maxAttempts ? "queued" : "failed"; }
      }
    } finally { this.running = false; }
  }
  snapshot(): QueueJob<T>[] { return [...this.jobs.values()].map((job) => ({ ...job })); }
}

export interface DatabasePort { query<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]>; schema(): Promise<string>; }
export class ReadOnlyDatabaseAssistant {
  constructor(private readonly database: DatabasePort) {}
  async describeSchema(): Promise<string> { return this.database.schema(); }
  async executeSafe<T>(sql: string, parameters: unknown[] = []): Promise<T[]> { if (!/^\s*select\b/i.test(sql)) throw new Error("AGI database assistant only permits SELECT statements."); if (/;\s*\S|--|\/\*/.test(sql)) throw new Error("Unsafe SQL rejected. Use a single parameterized SELECT statement."); return this.database.query<T>(sql, parameters); }
}

export interface CicdPort { review(diff: string): Promise<string>; generateTests(source: string): Promise<string>; validateDeployment(target: string): Promise<{ ok: boolean; details: string }>; }
export interface MonitoringPort { health(): Promise<{ ok: boolean; details?: string }>; increment(metric: string, value?: number, tags?: Record<string, string>): void; observe(metric: string, value: number, tags?: Record<string, string>): void; }
export interface AuthContext { userId: string; tenantId?: string; roles: string[]; permissions: string[]; sessionId: string; }
export function requirePermission(context: AuthContext, permission: string): void { if (!context.permissions.includes(permission) && !context.roles.includes("admin")) throw new Error(`Permission denied: '${permission}' is required.`); }

export interface ExternalConnector { readonly name: string; request<T>(operation: string, payload: unknown): Promise<T>; }
export interface CloudModelAdapter { readonly provider: "aws" | "gcp" | "azure" | "custom"; generate(request: AgiGenerationRequest): Promise<AgiGenerationResult>; }
export class ConnectorRegistry { private readonly connectors = new Map<string, ExternalConnector>(); register(connector: ExternalConnector): void { this.connectors.set(connector.name, connector); } get(name: string): ExternalConnector | undefined { return this.connectors.get(name); } }
