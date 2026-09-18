import test from "node:test";
import assert from "node:assert/strict";

import {
  PublicApiCatalogManager,
  type PublicApiCatalogEntry,
} from "../src/core/api/publicApiCatalog";

const sampleCatalog: PublicApiCatalogEntry[] = [
  {
    id: "open_meteo",
    name: "Open-Meteo",
    category: "Weather",
    description: "Weather forecast and climate data.",
    base_url: "https://api.open-meteo.com",
    documentation_url: "https://open-meteo.com",
    authentication: "none",
    https: true,
    risk_level: "READ_ONLY",
    capabilities: ["weather", "forecast", "temperature"],
    enabled: true,
    reliability_score: 0.96,
    health_status: "HEALTHY",
    last_checked: null,
    response_format: "json",
    rate_limit: "60/minute",
    privacy_classification: "PUBLIC",
    user_approval_required: false,
  },
  {
    id: "github_api",
    name: "GitHub API",
    category: "Development",
    description: "GitHub repository metadata and search API.",
    base_url: "https://api.github.com",
    documentation_url: "https://docs.github.com",
    authentication: "api_key",
    https: true,
    risk_level: "LIMITED_EXTERNAL",
    capabilities: ["github", "repository", "code_search"],
    enabled: true,
    reliability_score: 0.93,
    health_status: "HEALTHY",
    last_checked: null,
    response_format: "json",
    rate_limit: "60/hour",
    privacy_classification: "PARTIAL",
    user_approval_required: true,
  },
];

test("PublicApiCatalogManager imports and validates safe catalog entries", async () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-catalog.json" });
  manager.replaceCatalog(sampleCatalog);

  const catalog = manager.getAll();
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].health_status, "HEALTHY");
  assert.equal(catalog[0].risk_level, "READ_ONLY");
  assert.ok(catalog[0].base_url.startsWith("https://"));
});

test("PublicApiCatalogManager rejects malformed entries", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-catalog.json" });

  assert.throws(() => {
    manager.importEntries([
      {
        id: "broken",
        name: "",
        base_url: "http://insecure.example",
        authentication: "none",
        risk_level: "READ_ONLY",
      } as any,
    ]);
  });
});

test("PublicApiCatalogManager ranks matching searchable candidates", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-catalog.json" });
  manager.replaceCatalog(sampleCatalog);

  const results = manager.searchCandidates("weather forecast in Japan", { knownTools: ["openApplication"] });
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, "open_meteo");
  assert.ok(results[0].score > 0);
});

test("PublicApiCatalogManager ignores disabled APIs and blocks risky side effects", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-catalog.json" });
  manager.replaceCatalog([
    { ...sampleCatalog[0], enabled: false },
    { ...sampleCatalog[1], risk_level: "EXTERNAL_SIDE_EFFECT", enabled: true },
  ]);

  const candidates = manager.searchCandidates("post on social media");
  assert.equal(candidates.length, 0);

  const blocked = manager.validatePolicy({
    risk_level: "EXTERNAL_SIDE_EFFECT",
    user_approval_required: true,
    authenticated: true,
    domain: "twitter.com",
  }, { authorized: false, confirmed: false });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /confirmation/i);
});

test("PublicApiCatalogManager keeps canonical execution result contract for API failure", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-catalog.json" });
  const result = manager.normalizeExecutionResult({
    status: "FAILED",
    message: "API rate limited",
    execution_status: "FAILED",
    verification_status: "SKIPPED",
    request_id: "req-1",
    task_id: "task-1",
    operation_id: "op-1",
    correlation_id: "corr-1",
    timestamp: Date.now(),
    tool: "discoverApiCapability",
    error: { message: "API rate limited", code: "API_RATE_LIMITED" },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.execution_status, "FAILED");
  assert.equal(result.request_id, "req-1");
  assert.ok(result.operation_id);
});

test("PublicApiCatalogManager seeds useful no-key public APIs", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-builtins.json" });
  const ids = manager.listEnabled().map((entry) => entry.id);

  assert.ok(ids.includes("open_meteo"));
  assert.ok(ids.includes("frankfurter"));
  assert.ok(ids.includes("openalex"));
  assert.ok(ids.includes("wikipedia"));
  assert.ok(ids.includes("open_library"));
});

test("PublicApiCatalogManager preserves operation allowlists", () => {
  const manager = new PublicApiCatalogManager({ storagePath: "./data/test-public-api-builtins.json" });
  const entry = manager.getById("open_meteo");

  assert.ok(entry);
  assert.deepEqual(entry.supported_operations, ["v1/forecast"]);
});
