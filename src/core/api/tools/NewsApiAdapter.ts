import { ApiToolAdapter } from "../ApiToolAdapter";
import { apiDiscovery } from "../ApiDiscovery";

export class NewsApiAdapter extends ApiToolAdapter {
  public name = "getNews";
  public capability = "news.top_headlines";

  constructor() {
    super();
    apiDiscovery.discoverApi({
      id: "newsapi_default",
      name: "NewsAPI",
      category: "News",
      baseUrl: "https://newsapi.org/v2/top-headlines",
      capabilities: [this.capability],
      authentication: { required: true, type: "api_key" },
      pricing: { freeTier: true, notes: "Requires a NewsAPI key; free-tier use may be limited to development." },
    });
    void apiDiscovery.validateApi("newsapi_default");
  }

  protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
    const topic = typeof input.topic === "string" ? input.topic.trim().slice(0, 120) : "";
    const country = typeof input.country === "string" ? input.country.trim().toLowerCase() : "";
    if (country && !/^[a-z]{2}$/.test(country)) throw new Error("Country must be a two-letter ISO code.");
    if (!topic && !country) throw new Error("Provide a topic or a two-letter country code for news.");

    const url = new URL(provider.baseUrl);
    if (topic) url.searchParams.set("q", topic);
    if (country) url.searchParams.set("country", country);
    const response = await fetch(url, {
      headers: { "X-Api-Key": String(credentials || "") },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`News provider returned HTTP ${response.status}.`);

    const data = await response.json();
    return {
      provider: "NewsAPI",
      articles: Array.isArray(data.articles) ? data.articles.slice(0, 5).map((article: any) => ({
        title: String(article?.title || "").slice(0, 240),
        source: String(article?.source?.name || "").slice(0, 120),
        url: typeof article?.url === "string" ? article.url : undefined,
      })) : [],
      source: "https://newsapi.org",
    };
  }
}

export const newsApiTool = new NewsApiAdapter();
