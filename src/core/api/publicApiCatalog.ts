import fs from "node:fs";
import path from "node:path";

export type ApiRiskLevel =
  | "READ_ONLY"
  | "LIMITED_EXTERNAL"
  | "AUTHENTICATED"
  | "EXTERNAL_SIDE_EFFECT"
  | "HIGH_RISK";

export type CatalogHealthStatus =
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "DISABLED";

export type PrivacyClassification = "PUBLIC" | "PARTIAL" | "SENSITIVE" | "PRIVATE";

export interface PublicApiCatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  base_url: string;
  documentation_url?: string;
  source_repository?: string;
  license?: string;
  authentication: "none" | "api_key" | "bearer" | "oauth2" | "basic" | "custom";
  https: boolean;
  cors?: boolean;
  last_catalog_update?: string | null;
  last_checked?: string | null;
  health_status: CatalogHealthStatus;
  response_format?: string;
  rate_limit?: string;
  risk_level: ApiRiskLevel;
  privacy_classification: PrivacyClassification;
  capabilities: string[];
  supported_operations?: string[];
  reliability_score: number;
  latency_ms?: number;
  failure_rate?: number;
  last_successful_execution?: string | null;
  enabled: boolean;
  user_approval_required: boolean;
  disabled_reason?: string;
  domain_restrictions?: string[];
}

const BUILT_IN_PUBLIC_APIS: Partial<PublicApiCatalogEntry>[] = [
  {
    id: "open_meteo",
    name: "Open-Meteo",
    category: "Weather",
    description: "Current weather and forecast data without an API key.",
    base_url: "https://api.open-meteo.com",
    documentation_url: "https://open-meteo.com/en/docs",
    source_repository: "https://github.com/public-apis/public-apis",
    authentication: "none",
    https: true,
    response_format: "json",
    risk_level: "READ_ONLY",
    privacy_classification: "PUBLIC",
    capabilities: ["weather", "forecast", "temperature"],
    supported_operations: ["v1/forecast"],
    reliability_score: 0.9,
    enabled: true,
    user_approval_required: false,
  },
  {
    id: "frankfurter",
    name: "Frankfurter",
    category: "Currency",
    description: "Exchange rates and currency conversion from the European Central Bank.",
    base_url: "https://api.frankfurter.app",
    documentation_url: "https://www.frankfurter.app/docs",
    source_repository: "https://github.com/public-apis/public-apis",
    authentication: "none",
    https: true,
    response_format: "json",
    risk_level: "READ_ONLY",
    privacy_classification: "PUBLIC",
    capabilities: ["currency", "exchange_rates", "conversion"],
    supported_operations: ["v1/latest", "v1/currencies"],
    reliability_score: 0.9,
    enabled: true,
    user_approval_required: false,
  },
  {
    id: "openalex",
    name: "OpenAlex",
    category: "Research",
    description: "Open catalog of scholarly works, authors, institutions, and sources.",
    base_url: "https://api.openalex.org",
    documentation_url: "https://docs.openalex.org",
    source_repository: "https://github.com/public-apis/public-apis",
    authentication: "none",
    https: true,
    response_format: "json",
    risk_level: "READ_ONLY",
    privacy_classification: "PUBLIC",
    capabilities: ["research", "scholarly_search", "academic"],
    supported_operations: ["works"],
    reliability_score: 0.88,
    enabled: true,
    user_approval_required: false,
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    category: "Knowledge",
    description: "Search and retrieve encyclopedia content through the Wikimedia API.",
    base_url: "https://en.wikipedia.org",
    documentation_url: "https://www.mediawiki.org/wiki/API:Main_page",
    source_repository: "https://github.com/public-apis/public-apis",
    authentication: "none",
    https: true,
    response_format: "json",
    risk_level: "READ_ONLY",
    privacy_classification: "PUBLIC",
    capabilities: ["knowledge", "wikipedia", "encyclopedia"],
    supported_operations: ["w/api.php"],
    reliability_score: 0.95,
    enabled: true,
    user_approval_required: false,
  },
  {
    id: "open_library",
    name: "Open Library",
    category: "Books",
    description: "Search books, authors, and editions from the Internet Archive's Open Library.",
    base_url: "https://openlibrary.org",
    documentation_url: "https://openlibrary.org/developers/api",
    source_repository: "https://github.com/public-apis/public-apis",
    authentication: "none",
    https: true,
    response_format: "json",
    risk_level: "READ_ONLY",
    privacy_classification: "PUBLIC",
    capabilities: ["books", "authors", "reading"],
    supported_operations: ["search.json"],
    reliability_score: 0.88,
    enabled: true,
    user_approval_required: false,
  },
];

type CatalogInput = Partial<PublicApiCatalogEntry> & {
  baseUrl?: string;
  documentationUrl?: string;
};

export interface CatalogSearchOptions {
  limit?: number;
  knownTools?: string[];
  authorized?: boolean;
  confirmed?: boolean;
}

export interface PublicApiPolicyContext {
  resource?: string;
  domain?: string;
  authorized?: boolean;
  confirmed?: boolean;
  allowedDomains?: string[];
}

export interface CatalogCandidate extends PublicApiCatalogEntry {
  score: number;
  reason: string;
}

export interface PublicApiCatalogImportSummary {
  source: string;
  categories: number;
  discovered: number;
  imported: number;
  skipped: number;
}

export interface CatalogPolicyDecision {
  allowed: boolean;
  reason: string;
  requireConfirmation: boolean;
  riskLevel: ApiRiskLevel;
}

export interface CatalogExecutionResult {
  status: "SUCCESS" | "FAILED" | "UNCERTAIN";
  verified: boolean;
  request_id?: string;
  task_id?: string;
  operation_id?: string;
  correlation_id?: string;
  timestamp: number;
  duration_ms?: number;
  data?: unknown;
  error?: { code?: string; message: string; retryable?: boolean } | null;
  execution_status?: "SUCCESS" | "FAILED" | "TIMEOUT" | "SKIPPED";
  verification_status?: "VERIFIED" | "FAILED" | "UNCERTAIN" | "NOT_REQUIRED" | "SKIPPED";
  tool?: string;
  message: string;
}

const DEFAULT_RISK_ORDER: Record<ApiRiskLevel, number> = {
  READ_ONLY: 1,
  LIMITED_EXTERNAL: 2,
  AUTHENTICATED: 3,
  EXTERNAL_SIDE_EFFECT: 4,
  HIGH_RISK: 5,
};

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    return parsed.href && parsed.protocol === "https:" ? parsed.href.replace(/[?#].*$/, "").replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

export class PublicApiCatalogManager {
  private readonly entries = new Map<string, PublicApiCatalogEntry>();
  private readonly storagePath: string;

  constructor(options: { storagePath?: string } = {}) {
    this.storagePath = options.storagePath || path.join(process.cwd(), "data", "public-api-catalog.json");
    this.ensureDirectory();
    this.loadFromDisk();
    this.importEntries(BUILT_IN_PUBLIC_APIS, { persist: true, preserveOperational: true });
  }

  private ensureDirectory(): void {
    const target = path.dirname(this.storagePath);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.storagePath, "utf-8"));
      if (Array.isArray(raw)) {
        this.importEntries(raw, { persist: false });
      }
    } catch {
      // A malformed local catalog is tolerated; it will be rebuilt or updated.
    }
  }

  private persist(): void {
    const data = Array.from(this.entries.values());
    const tempPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempPath, this.storagePath);
  }

  public replaceCatalog(entries: PublicApiCatalogEntry[]): PublicApiCatalogEntry[] {
    this.entries.clear();
    this.importEntries(entries, { persist: true });
    return this.getAll();
  }

  /** Parse the public-apis Markdown index without turning rows into tools. */
  public importPublicApisMarkdown(markdown: string, options: { maxEntries?: number; source?: string } = {}): PublicApiCatalogImportSummary {
    const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 100, 500));
    const source = options.source || "https://github.com/public-apis/public-apis";
    const entries: Partial<PublicApiCatalogEntry>[] = [];
    let category = "General";
    let discovered = 0;
    let skipped = 0;

    for (const line of markdown.split(/\r?\n/)) {
      const heading = line.match(/^###\s+(.+?)\s*$/);
      if (heading) {
        category = heading[1].trim();
        continue;
      }
      if (!line.trim().startsWith("|") || /^\|\s*-/.test(line.trim())) continue;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 5 || !/^\[.+\]\(https?:\/\//i.test(cells[0])) continue;
      discovered += 1;
      const match = cells[0].match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/i);
      if (!match || cells[3].toLowerCase() !== "yes") {
        skipped += 1;
        continue;
      }
      const authentication = cells[2].replace(/[`*_]/g, "").trim().toLowerCase();
      const authType = authentication === "no" ? "none" : authentication === "oauth" ? "oauth2" : "api_key";
      entries.push({
        id: match[1], name: match[1], category, description: cells[1], base_url: match[2],
        documentation_url: match[2], source_repository: source, authentication: authType,
        https: true, cors: cells[4].toLowerCase() === "yes", health_status: "UNKNOWN",
        risk_level: authType === "none" ? "READ_ONLY" : "AUTHENTICATED", privacy_classification: "PUBLIC",
        capabilities: [category.toLowerCase()], reliability_score: 0.5, enabled: true,
        user_approval_required: authType !== "none",
      });
      if (entries.length >= maxEntries) break;
    }

    let imported = 0;
    for (const entry of entries) {
      try {
        this.importEntries([entry], { persist: false, preserveOperational: true });
        imported += 1;
      } catch {
        skipped += 1;
      }
    }
    this.persist();
    return { source, categories: new Set(entries.map((entry) => entry.category)).size, discovered, imported, skipped };
  }

  public async refreshFromPublicApis(options: { maxEntries?: number; sourceUrl?: string } = {}): Promise<PublicApiCatalogImportSummary> {
    const sourceUrl = options.sourceUrl || "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Public API catalog refresh failed with HTTP ${response.status}.`);
    return this.importPublicApisMarkdown(await response.text(), { maxEntries: options.maxEntries, source: "https://github.com/public-apis/public-apis" });
  }

  public importEntries(
    entries: Partial<PublicApiCatalogEntry>[],
    options: { persist?: boolean; preserveOperational?: boolean } = { persist: true },
  ): PublicApiCatalogEntry[] {
    if (!Array.isArray(entries)) {
      throw new Error("Catalog import requires an array of API entries.");
    }

    const results: PublicApiCatalogEntry[] = [];
    for (const entry of entries) {
      const sanitized = this.validateEntry(entry);
      const key = normalizeId(sanitized.id);
      const existing = this.entries.get(key);
      if (existing) {
        const merged = { ...existing, ...sanitized };
        if (options.preserveOperational) {
          for (const field of ["last_checked", "health_status", "reliability_score", "latency_ms", "failure_rate", "last_successful_execution", "enabled", "disabled_reason"] as const) {
            (merged as any)[field] = existing[field];
          }
        }
        this.entries.set(key, merged);
      } else {
        this.entries.set(key, sanitized);
      }
      results.push(this.entries.get(key)!);
    }

    if (options.persist !== false) this.persist();
    return results;
  }

  public getAll(): PublicApiCatalogEntry[] {
    return Array.from(this.entries.values());
  }

  public getById(id: string): PublicApiCatalogEntry | undefined {
    return this.entries.get(normalizeId(id));
  }

  public listEnabled(): PublicApiCatalogEntry[] {
    return this.getAll().filter((entry) => entry.enabled && entry.health_status !== "DISABLED");
  }

  public validateEntry(entry: CatalogInput): PublicApiCatalogEntry {
    if (!entry || typeof entry !== "object") {
      throw new Error("Catalog entry must be an object.");
    }

    const id = (entry.id || entry.name || "api").toString().trim();
    const name = (entry.name || "Unknown API").toString().trim();
    const category = (entry.category || "General").toString().trim();
    const description = (entry.description || "").toString().trim();
    const baseUrl = (entry.base_url || entry.baseUrl || "").toString().trim();

    if (!id || !name) {
      throw new Error("Catalog entries require a non-empty id and name.");
    }
    if (!baseUrl) {
      throw new Error(`Catalog entry '${name}' requires a base_url.`);
    }
    if (name === "" || name.trim().length === 0) {
      throw new Error("Catalog entry name must not be empty.");
    }
    const resolvedBaseUrl = safeUrl(baseUrl);
    if (!resolvedBaseUrl) {
      throw new Error(`Catalog entry '${name}' has an invalid base_url.`);
    }

    if (baseUrl && baseUrl.startsWith("http://")) {
      throw new Error(`Catalog entry '${name}' uses an insecure HTTP base URL.`);
    }
    const riskLevel = (entry.risk_level || "READ_ONLY") as ApiRiskLevel;
    if (!(riskLevel in DEFAULT_RISK_ORDER)) {
      throw new Error(`Unsupported risk_level '${riskLevel}' in '${name}'.`);
    }

    const httpSecure = entry.https ?? resolvedBaseUrl.startsWith("https://");
    const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.map((cap) => String(cap).trim()).filter(Boolean) : [];
    const reliability = Number(entry.reliability_score ?? 0.5);
    const failureRate = Number(entry.failure_rate ?? 0);
    if (!Number.isFinite(reliability) || reliability < 0 || reliability > 1) throw new Error(`Invalid reliability_score in '${name}'.`);
    if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) throw new Error(`Invalid failure_rate in '${name}'.`);
    const normalized: PublicApiCatalogEntry = {
      id: normalizeId(id),
      name,
      category,
      description,
      base_url: resolvedBaseUrl,
      documentation_url: entry.documentation_url || entry.documentationUrl,
      source_repository: entry.source_repository,
      license: entry.license,
      authentication: entry.authentication || "none",
      https: httpSecure,
      cors: entry.cors ?? false,
      last_catalog_update: entry.last_catalog_update ?? new Date().toISOString(),
      last_checked: entry.last_checked ?? null,
      health_status: entry.health_status || "UNKNOWN",
      response_format: entry.response_format || "json",
      rate_limit: entry.rate_limit,
      risk_level: riskLevel,
      privacy_classification: entry.privacy_classification || "PUBLIC",
      capabilities,
      supported_operations: entry.supported_operations || [],
      reliability_score: reliability,
      latency_ms: typeof entry.latency_ms === "number" ? entry.latency_ms : undefined,
      failure_rate: failureRate,
      last_successful_execution: entry.last_successful_execution ?? null,
      enabled: entry.enabled !== false,
      user_approval_required: Boolean(entry.user_approval_required),
      disabled_reason: entry.disabled_reason,
      domain_restrictions: entry.domain_restrictions || [],
    };

    if (normalized.authentication !== "none" && !normalized.user_approval_required) {
      normalized.user_approval_required = true;
    }

    return normalized;
  }

  public searchCandidates(
    intent: string,
    options: CatalogSearchOptions = {},
  ): CatalogCandidate[] {
    const normalizedIntent = (intent || "").toLowerCase();
    if (!normalizedIntent.trim()) return [];

    const limit = Math.max(1, options.limit ?? 3);
    const knownTools = new Set((options.knownTools || []).map((tool) => tool.toLowerCase()));
    const scored: CatalogCandidate[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.enabled || entry.health_status === "DISABLED") continue;

      const text = [entry.name, entry.category, entry.description, ...(entry.capabilities || [])].join(" ").toLowerCase();
      const matches = entry.capabilities.some((cap) => normalizedIntent.includes(cap.toLowerCase()))
        || entry.name.toLowerCase().includes(normalizedIntent)
        || entry.category.toLowerCase().includes(normalizedIntent)
        || entry.description.toLowerCase().includes(normalizedIntent)
        || text.includes(normalizedIntent);

      if (!matches) {
        const tokens = normalizedIntent.split(/[^a-z0-9]+/).filter(Boolean);
        const tokenMatches = tokens.filter((token) => text.includes(token)).length;
        if (tokenMatches === 0) continue;
      }

      if (knownTools.has(entry.name.toLowerCase()) || knownTools.has(entry.id.toLowerCase())) {
        continue;
      }

      const policy = this.validatePolicy({
        risk_level: entry.risk_level,
        user_approval_required: entry.user_approval_required,
        authenticated: entry.authentication !== "none",
        domain: entry.base_url,
      }, {
        authorized: options.authorized,
        confirmed: options.confirmed,
      });
      if (!policy.allowed) continue;

      const score = this.computeScore(entry, normalizedIntent);
      if (score <= 0) continue;

      scored.push({ ...entry, score, reason: "Capability and policy match" });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  public validatePolicy(
    entry: { risk_level?: ApiRiskLevel; user_approval_required?: boolean; authenticated?: boolean; domain?: string },
    context: PublicApiPolicyContext = {},
  ): CatalogPolicyDecision {
    const riskLevel = entry.risk_level || "READ_ONLY";
    const requireConfirmation = Boolean(entry.user_approval_required || riskLevel === "EXTERNAL_SIDE_EFFECT" || riskLevel === "HIGH_RISK");

    if (riskLevel === "HIGH_RISK") {
      if (!(context.authorized === true && context.confirmed === true)) {
        return {
          allowed: false,
          reason: "High-risk API access requires explicit approval and elevated policy permission.",
          requireConfirmation: true,
          riskLevel,
        };
      }
    }

    if (riskLevel === "EXTERNAL_SIDE_EFFECT") {
      if (!(context.authorized === true && context.confirmed === true)) {
        return {
          allowed: false,
          reason: "External side-effect API access requires explicit confirmation before execution.",
          requireConfirmation: true,
          riskLevel,
        };
      }
    }

    if (entry.authenticated && !context.authorized) {
      return {
        allowed: false,
        reason: "This API requires explicit configuration and authorization before use.",
        requireConfirmation: true,
        riskLevel,
      };
    }

    if (context.allowedDomains && context.domain) {
      const hostname = (() => {
        try {
          const parsed = safeUrl(context.domain);
          return parsed ? new URL(parsed).hostname.toLowerCase() : context.domain.toLowerCase();
        } catch {
          return context.domain.toLowerCase();
        }
      })();
      const isAllowed = context.allowedDomains.some((allowed) => {
        const normalized = allowed.toLowerCase().replace(/^\*\./, "");
        return hostname === normalized || hostname.endsWith(`.${normalized}`);
      });
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Domain '${hostname}' is outside the approved policy scope.`,
          requireConfirmation: true,
          riskLevel,
        };
      }
    }

    if (requireConfirmation && !(context.authorized === true || context.confirmed === true)) {
      return {
        allowed: false,
        reason: `The selected API requires confirmation before it can be used safely.`,
        requireConfirmation: true,
        riskLevel,
      };
    }

    return {
      allowed: true,
      reason: "API passes the local policy gate.",
      requireConfirmation: requireConfirmation && !(context.authorized === true && context.confirmed === true),
      riskLevel,
    };
  }

  public normalizeExecutionResult(result: Partial<CatalogExecutionResult> & { message?: string }): CatalogExecutionResult {
    const status = (result.status || (result.error ? "FAILED" : "SUCCESS")).toUpperCase();
    const executionStatus = (result.execution_status || (status === "FAILED" ? "FAILED" : "SUCCESS")).toUpperCase();
    const verificationStatus = (result.verification_status || "SKIPPED").toUpperCase();
    const message = result.message || result.error?.message || "API execution completed.";

    return {
      status: status === "SUCCESS" ? "SUCCESS" : status === "FAILED" ? "FAILED" : "UNCERTAIN",
      verified: Boolean(result.verified) || verificationStatus === "VERIFIED",
      request_id: result.request_id,
      task_id: result.task_id,
      operation_id: result.operation_id || `api-${Date.now()}`,
      correlation_id: result.correlation_id,
      timestamp: Number(result.timestamp ?? Date.now()),
      duration_ms: typeof result.duration_ms === "number" ? result.duration_ms : undefined,
      data: result.data ?? null,
      error: result.error ?? null,
      execution_status: executionStatus as CatalogExecutionResult["execution_status"],
      verification_status: verificationStatus as CatalogExecutionResult["verification_status"],
      tool: result.tool || "discoverApiCapability",
      message,
    };
  }

  public getCapabilityStatus(capability: string): PublicApiCatalogEntry[] {
    return this.getAll().filter((entry) => entry.enabled && entry.capabilities.some((cap) => cap.toLowerCase() === capability.toLowerCase()));
  }

  public discoverCapability(capability: string, context: { intent?: string; knownTools?: string[] } = {}): CatalogCandidate[] {
    return this.searchCandidates(context.intent || capability, {
      limit: 3,
      knownTools: context.knownTools || [],
    });
  }

  private computeScore(entry: PublicApiCatalogEntry, intent: string): number {
    let score = entry.reliability_score * 100;
    const text = `${entry.name} ${entry.category} ${entry.description} ${entry.capabilities.join(" ")}`.toLowerCase();
    const intentTokens = intent.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

    let tokenMatchScore = 0;
    for (const token of intentTokens) {
      if (!token) continue;
      if (text.includes(token)) tokenMatchScore += 12;
    }

    score += tokenMatchScore;
    score += entry.https ? 8 : -15;
    score += entry.health_status === "HEALTHY" ? 12 : entry.health_status === "DEGRADED" ? 4 : -20;
    score -= (entry.failure_rate || 0) * 30;
    score -= DEFAULT_RISK_ORDER[entry.risk_level] * 8;
    score -= entry.user_approval_required ? 10 : 0;
    score -= entry.authentication !== "none" ? 6 : 0;

    return Math.max(0, Math.round(score));
  }
}

export const publicApiCatalogManager = new PublicApiCatalogManager();
