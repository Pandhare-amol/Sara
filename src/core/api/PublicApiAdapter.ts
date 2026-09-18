import { publicApiCatalogManager, type CatalogExecutionResult, type PublicApiCatalogEntry } from "./publicApiCatalog";

export interface APIExecutionRequest {
  api_id: string;
  operation: string;
  parameters?: Record<string, string | number | boolean>;
  request_id?: string;
  task_id?: string;
  correlation_id?: string;
  operation_id?: string;
  authorized?: boolean;
  confirmed?: boolean;
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RETRIES = 2;
const breakers = new Map<string, { failures: number; openUntil: number }>();

/** Controlled GET-only adapter for catalog entries. Gemini supplies intent/parameters, never code. */
export async function executePublicApi(request: APIExecutionRequest): Promise<CatalogExecutionResult> {
  const started = Date.now();
  const operationId = request.operation_id || `api-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const entry = publicApiCatalogManager.getById(request.api_id);
  if (!entry) return failure(request, operationId, started, "API_NOT_FOUND", "The requested API is not in the local catalog.");
  if (!entry.enabled || entry.health_status === "DISABLED") return failure(request, operationId, started, "API_DISABLED", "This API is disabled in the local catalog.");
  const policy = publicApiCatalogManager.validatePolicy({
    risk_level: entry.risk_level,
    user_approval_required: entry.user_approval_required,
    authenticated: entry.authentication !== "none",
    domain: entry.base_url,
  }, { authorized: request.authorized, confirmed: request.confirmed });
  if (!policy.allowed) return failure(request, operationId, started, "POLICY_DENIED", policy.reason);
  if (entry.authentication !== "none") return failure(request, operationId, started, "AUTH_REQUIRED", "Credentials must be configured explicitly; secrets are never read from catalog data.");

  const breaker = breakers.get(entry.id);
  if (breaker && breaker.openUntil > Date.now()) return failure(request, operationId, started, "CIRCUIT_OPEN", "The API is temporarily unavailable after repeated failures.", true);

  const operation = String(request.operation || "").trim();
  if (!/^[a-zA-Z0-9_./-]{1,80}$/.test(operation) || /^(post|put|patch|delete|send|create|update|remove)/i.test(operation)) {
    return failure(request, operationId, started, "UNSAFE_OPERATION", "Only bounded read operations are allowed by the public API adapter.");
  }
  if (entry.supported_operations?.length && !entry.supported_operations.includes(operation)) {
    return failure(request, operationId, started, "OPERATION_NOT_ALLOWED", `Operation '${operation}' is not approved for ${entry.name}.`);
  }
  const suffix = operation === "GET" ? "" : `/${operation.replace(/^\/+/, "")}`;
  const url = new URL(`${entry.base_url.replace(/\/$/, "")}${suffix}`);
  for (const [key, value] of Object.entries(request.parameters || {})) {
    if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(key)) return failure(request, operationId, started, "INVALID_PARAMETER", `Invalid parameter name '${key}'.`);
    url.searchParams.set(key, String(value));
  }

  let lastError = "API request failed.";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10000), headers: { accept: "application/json,text/plain;q=0.8" } });
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the configured size limit.");
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the configured size limit.");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let data: unknown = body;
      try { data = JSON.parse(body); } catch { /* text response is valid when catalog says so */ }
      breakers.delete(entry.id);
      return publicApiCatalogManager.normalizeExecutionResult({ status: "SUCCESS", verified: true, execution_status: "SUCCESS", verification_status: "VERIFIED", request_id: request.request_id, task_id: request.task_id, correlation_id: request.correlation_id, operation_id: operationId, timestamp: Date.now(), duration_ms: Date.now() - started, data, tool: "executeDiscoveredCapability", message: `Read ${entry.name} successfully.` });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_RETRIES) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  const state = breakers.get(entry.id) || { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= 3) state.openUntil = Date.now() + 30_000;
  breakers.set(entry.id, state);
  return failure(request, operationId, started, "API_REQUEST_FAILED", lastError, true);
}

function failure(request: APIExecutionRequest, operationId: string, started: number, code: string, message: string, retryable = false): CatalogExecutionResult {
  return publicApiCatalogManager.normalizeExecutionResult({ status: "FAILED", verified: false, execution_status: "FAILED", verification_status: "SKIPPED", request_id: request.request_id, task_id: request.task_id, correlation_id: request.correlation_id, operation_id: operationId, timestamp: Date.now(), duration_ms: Date.now() - started, error: { code, message, retryable }, tool: "executeDiscoveredCapability", message });
}

export function catalogEntryForAdapter(apiId: string): PublicApiCatalogEntry | undefined { return publicApiCatalogManager.getById(apiId); }
