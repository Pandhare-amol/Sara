import { ApiToolAdapter } from "../ApiToolAdapter";
import { apiDiscovery } from "../ApiDiscovery";

export class FinanceApiAdapter extends ApiToolAdapter {
  public name = "getFinanceData";
  public capability = "finance.quote";

  constructor() {
    super();
    apiDiscovery.discoverApi({
      id: "alphavantage_default",
      name: "Alpha Vantage",
      category: "Finance",
      baseUrl: "https://www.alphavantage.co/query",
      capabilities: [this.capability],
      authentication: { required: true, type: "api_key" },
      pricing: { freeTier: true, notes: "Requires an Alpha Vantage API key and is subject to provider rate limits." },
    });
    void apiDiscovery.validateApi("alphavantage_default");
  }

  protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
    const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol)) throw new Error("Provide a valid stock symbol.");

    const url = new URL(provider.baseUrl);
    url.searchParams.set("function", "GLOBAL_QUOTE");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", String(credentials || ""));
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Finance provider returned HTTP ${response.status}.`);

    const data = await response.json();
    const quote = data["Global Quote"];
    if (!quote || Object.keys(quote).length === 0) {
      if (data["Information"] || data["Note"]) throw new Error("Alpha Vantage rate limit or provider restriction reached.");
      throw new Error("No quote was returned for that symbol.");
    }

    return {
      provider: "Alpha Vantage",
      symbol: quote["01. symbol"],
      price: quote["05. price"],
      change: quote["09. change"],
      changePercent: quote["10. change percent"],
      source: "https://www.alphavantage.co",
    };
  }
}

export const financeApiTool = new FinanceApiAdapter();
