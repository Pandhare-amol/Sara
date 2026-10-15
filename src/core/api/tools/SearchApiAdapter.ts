import { ApiToolAdapter } from "../ApiToolAdapter";
import { apiDiscovery } from "../ApiDiscovery";

export class SearchApiAdapter extends ApiToolAdapter {
  public name = "searchPublicWeb";
  public capability = "search.web";

  constructor() {
    super();
    apiDiscovery.discoverApi({
      id: "duckduckgo_lite",
      name: "DuckDuckGo Instant Answer API",
      category: "Search",
      baseUrl: "https://api.duckduckgo.com",
      capabilities: [this.capability],
      authentication: { required: false, type: "none" },
      reliability: 60,
      pricing: { freeTier: true, notes: "No API key required; returns instant answers and related topics, not full search-page results." },
    });
    void apiDiscovery.validateApi("duckduckgo_lite");
  }

  protected async performApiCall(provider: any, input: any): Promise<any> {
    const query = typeof input.query === "string" ? input.query.trim().slice(0, 300) : "";
    if (!query) throw new Error("Query is required for search.");

    const url = new URL(provider.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);

    const data = await response.json();
    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    const results = topics.flatMap((topic: any) => {
      if (Array.isArray(topic?.Topics)) return topic.Topics;
      return [topic];
    }).filter((topic: any) => typeof topic?.Text === "string" && typeof topic?.FirstURL === "string")
      .slice(0, 5)
      .map((topic: any) => ({ text: topic.Text.slice(0, 500), url: topic.FirstURL }));

    return {
      provider: "DuckDuckGo Instant Answer API",
      abstract: String(data.AbstractText || "").slice(0, 1200),
      abstractUrl: typeof data.AbstractURL === "string" ? data.AbstractURL : undefined,
      results,
      source: "https://duckduckgo.com",
      limitations: "Instant answers and related topics only; this is not full search. Use desktop browser search for full result pages.",
    };
  }
}

export const searchApiTool = new SearchApiAdapter();
