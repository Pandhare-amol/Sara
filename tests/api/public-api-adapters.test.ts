import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("public adapters use keyless Open-Meteo, keep keys out of NewsAPI URLs, and redact key-bearing errors", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-public-api-test-"));
  const keyNames = ["SARA_DATA_DIR", "OPENWEATHER_DEFAULT_API_KEY", "NEWSAPI_DEFAULT_API_KEY", "ALPHAVANTAGE_DEFAULT_API_KEY"] as const;
  const oldValues = new Map(keyNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const sentRequests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const newsKey = "news-test-secret-123";
  const alphaKey = "alpha-test-secret-456";

  process.env.SARA_DATA_DIR = tempDir;
  delete process.env.OPENWEATHER_DEFAULT_API_KEY;
  process.env.NEWSAPI_DEFAULT_API_KEY = newsKey;
  process.env.ALPHAVANTAGE_DEFAULT_API_KEY = alphaKey;

  try {
    const [{ weatherApiTool }, { newsApiTool }, { financeApiTool }, { searchApiTool }, { apiCredentialManager }, { apiRegistry }] = await Promise.all([
      import("../../src/core/api/tools/WeatherApiAdapter"),
      import("../../src/core/api/tools/NewsApiAdapter"),
      import("../../src/core/api/tools/FinanceApiAdapter"),
      import("../../src/core/api/tools/SearchApiAdapter"),
      import("../../src/core/api/ApiCredentialManager"),
      import("../../src/core/api/ApiRegistry"),
    ]);

    assert.equal(apiCredentialManager.getCredential("newsapi_default"), newsKey);
    assert.equal(apiCredentialManager.getCredential("alphavantage_default"), alphaKey);
    assert.equal(apiRegistry.getProvider("open_meteo_default")?.verified, false, "provider registration is not a live health check");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = new URL(url);
      const headers = (init?.headers || {}) as Record<string, string>;
      sentRequests.push({ url, headers });
      if (parsed.hostname === "geocoding-api.open-meteo.com") {
        return new Response(JSON.stringify({ results: [{ latitude: 17.6599, longitude: 75.9064, name: "Solapur", country: "India" }] }), { status: 200 });
      }
      if (parsed.hostname === "api.open-meteo.com") {
        return new Response(JSON.stringify({
          current: {
            temperature_2m: 28.5,
            apparent_temperature: 30.1,
            relative_humidity_2m: 62,
            weather_code: 2,
            wind_speed_10m: 11.2,
            wind_direction_10m: 240,
            time: "2026-10-14T14:00",
          },
          current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
        }), { status: 200 });
      }
      if (parsed.hostname === "api.duckduckgo.com") {
        return new Response(JSON.stringify({
          AbstractText: "A concise public answer.",
          AbstractURL: "https://example.test/answer",
          RelatedTopics: [{ Topics: [{ Text: "Related fact", FirstURL: "https://example.test/related" }] }],
        }), { status: 200 });
      }
      if (parsed.hostname === "newsapi.org") {
        assert.equal(headers["X-Api-Key"], newsKey);
        return new Response(JSON.stringify({ articles: [{ title: "Test headline", source: { name: "Test Wire" }, url: "https://example.test/article" }] }), { status: 200 });
      }
      if (parsed.hostname === "www.alphavantage.co") {
        throw new Error(`Mock transport diagnostic: ${url}`);
      }
      throw new Error(`Unexpected test destination ${parsed.hostname}`);
    };

    const weather = await weatherApiTool.execute({ location: "Solapur" }, {});
    assert.equal(weather.success, true);
    assert.equal(weather.provider, "open_meteo_default");
    assert.equal((weather.data as any).temperature, 28.5);
    assert.equal((weather.data as any).condition, "partly cloudy");
    assert.equal(sentRequests.filter((request) => new URL(request.url).hostname.includes("open-meteo.com")).length, 2);

    const news = await newsApiTool.execute({ topic: "science", country: "in" }, {});
    assert.equal(news.success, true);
    assert.equal((news.data as any).articles[0].title, "Test headline");
    const newsRequest = sentRequests.find((request) => new URL(request.url).hostname === "newsapi.org");
    assert.ok(newsRequest);
    assert.ok(!newsRequest.url.includes(newsKey), "NewsAPI key must not be put in the request URL");

    const search = await searchApiTool.execute({ query: "open data" }, {});
    assert.equal(search.success, true);
    assert.equal((search.data as any).abstract, "A concise public answer.");
    assert.equal((search.data as any).results[0].url, "https://example.test/related");
    assert.match((search.data as any).limitations, /not full search/i);
    assert.ok(!sentRequests.find((request) => new URL(request.url).hostname === "api.duckduckgo.com")?.url.includes("key="));

    const finance = await financeApiTool.execute({ symbol: "IBM" }, {});
    assert.equal(finance.success, false);
    assert.match(finance.error?.message || "", /REDACTED/);
    assert.ok(!String(finance.error?.message).includes(alphaKey), "API keys must not be returned in provider errors");

    const catalogPath = path.join(tempDir, "public-api-catalog.json");
    assert.ok(fs.existsSync(catalogPath), "catalog persistence should use the per-user data directory when configured");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of keyNames) {
      const old = oldValues.get(name);
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
