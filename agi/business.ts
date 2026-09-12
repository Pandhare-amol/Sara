import type { AgiGenerationRequest, AgiGenerationResult } from "./types";
import type { AgiService } from "./service";

export type MarketRegion = "US" | "EU" | "ASIA" | "GLOBAL";
export interface QuoteRequest { symbol: string; region?: MarketRegion; }
export interface MarketQuote { symbol: string; price: number; currency: string; change?: number; changePercent?: number; asOf: string; source: string; delayed: boolean; }
export interface MarketDataProvider { readonly name: string; quote(request: QuoteRequest): Promise<MarketQuote>; fundamentals?(symbol: string): Promise<Record<string, unknown>>; }
export interface BusinessLadyConfig { enabled: boolean; name?: "Sara" | "Victoria"; marketData?: MarketDataProvider; maxQuoteAgeMs?: number; }

export interface TwelveDataProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  delayed?: boolean;
  fetcher?: typeof fetch;
}

/** Adapter for Twelve Data's quote endpoint. The account plan determines whether quotes are real-time or delayed. */
export function twelveDataProvider(options: TwelveDataProviderOptions): MarketDataProvider {
  if (!options.apiKey.trim()) throw new Error("Twelve Data API key is required.");
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.twelvedata.com/quote";
  return {
    name: "twelve-data",
    async quote(request) {
      const url = new URL(baseUrl);
      url.searchParams.set("symbol", normalizeSymbol(request.symbol));
      url.searchParams.set("apikey", options.apiKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await fetcher(url, { signal: controller.signal });
        const payload = await response.json() as Record<string, unknown>;
        if (!response.ok || typeof payload.status === "string" && payload.status.toLowerCase() === "error") throw new Error(String(payload.message ?? `Market provider returned HTTP ${response.status}.`));
        const asOf = String(payload.datetime ?? "");
        return {
          symbol: String(payload.symbol ?? request.symbol).toUpperCase(),
          price: Number(payload.close),
          currency: String(payload.currency ?? ""),
          change: payload.change === undefined ? undefined : Number(payload.change),
          changePercent: payload.percent_change === undefined ? undefined : Number(payload.percent_change),
          asOf: toIsoTimestamp(asOf, String(payload.exchange_timezone ?? "UTC")),
          source: "Twelve Data /quote",
          delayed: options.delayed ?? true,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("Market provider timed out.");
        throw error;
      } finally { clearTimeout(timeout); }
    },
  };
}

export const BUSINESS_LADY_SYSTEM_PROMPT = `You are Sara, a confident and empathetic professional business woman and strategic mentor, with the communication style of a successful 35-45 year old business leader. You are authoritative, concise, approachable, integrity-driven, innovation-minded, and results-focused. Your expertise includes business strategy, entrepreneurship, leadership, marketing, operations, finance, accounting, economics, corporate finance, fundraising, M&A, and share-market analysis.

Use technical analysis (trends, support/resistance, indicators), fundamental analysis (valuation, ratios, earnings, cash flow), market psychology, sectors, global market context, derivatives, and risk management when relevant. Use frameworks such as SWOT, Porter's Five Forces, PESTEL, and Blue Ocean strategy. Explain assumptions, risks, alternatives, and what evidence would change the conclusion.

TRUTH POLICY: Never invent live prices, market movements, financial ratios, earnings, news, sources, or personal experience. Separate LIVE/DATA, HISTORICAL, ANALYSIS, ASSUMPTION, and UNKNOWN. A market quote is real-time only when the supplied source says so and its timestamp is fresh. Otherwise call it delayed or unavailable. State the source and as-of time. Do not give personalized financial, legal, or tax advice; provide educational analysis and recommend a qualified professional for regulated decisions. Ask for jurisdiction, time horizon, risk tolerance, and goals when they materially affect an answer.

You may challenge the user's assumptions respectfully. Favor capital preservation, diversification, position sizing, and downside analysis over confident predictions. `;

export const responseTemplates = {
  marketAdvice: "Let's analyze {company} using the available evidence. The current data is {freshness}, sourced from {source} as of {asOf}. The key drivers are {reason}. Would you like a fundamentals or risk analysis next?",
  businessStrategy: "Let's analyze this opportunity together. The strategic lever is {strategy}; here is how we could implement it and measure the result.",
  leadershipAdvice: "Empowering your team is crucial. I would start with {action}, then measure {metric}.",
  personalFinance: "For education only, let's compare {asset_classes} against your goals, time horizon, liquidity needs, and risk tolerance.",
  mentorship: "Here is the honest, practical advice: {advice}",
} as const;

export class BusinessLadyService {
  constructor(private readonly agi: AgiService, private readonly config: BusinessLadyConfig) {}

  isEnabled(): boolean { return this.config.enabled; }

  async generate(request: AgiGenerationRequest): Promise<AgiGenerationResult | null> {
    if (!this.config.enabled) return this.agi.generate(request);
    const marketContext = await this.getMarketContext(request.input);
    return this.agi.generate({ ...request, input: `${BUSINESS_LADY_SYSTEM_PROMPT}\n\n${marketContext}\n\nUser request: ${request.input}` });
  }

  async quote(request: QuoteRequest): Promise<MarketQuote> {
    if (!this.config.enabled || !this.config.marketData) throw new Error("Live market data is unavailable. Configure an approved MarketDataProvider before requesting quotes.");
    const quote = await this.config.marketData.quote({ ...request, symbol: normalizeSymbol(request.symbol) });
    validateQuote(quote, this.config.maxQuoteAgeMs ?? 120_000);
    return quote;
  }

  private async getMarketContext(input: string): Promise<string> {
    if (!/\b(stock|share|market|price|quote|ticker|fundamental|technical|portfolio|invest|option|future)\b/i.test(input)) return "MARKET DATA: Not required for this request. Do not imply that live market data was checked.";
    const symbol = input.match(/\b[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b/)?.[0];
    if (!symbol || !this.config.marketData) return "MARKET DATA: UNAVAILABLE. Do not invent current prices, news, ratios, or market movements. Explain what data is missing.";
    try {
      const quote = await this.quote({ symbol });
      return `MARKET DATA: ${quote.delayed ? "DELAYED" : "LIVE"}; source=${quote.source}; asOf=${quote.asOf}; symbol=${quote.symbol}; price=${quote.price} ${quote.currency}; change=${quote.change ?? "unknown"}; changePercent=${quote.changePercent ?? "unknown"}. Treat this as data, not a recommendation.`;
    } catch (error) {
      return `MARKET DATA: UNAVAILABLE (${error instanceof Error ? error.message : "provider error"}). Do not invent current prices or claim real-time access.`;
    }
  }
}

function normalizeSymbol(symbol: string): string { const normalized = symbol.trim().toUpperCase(); if (!/^[A-Z0-9.-]{1,20}$/.test(normalized)) throw new Error("Invalid market symbol."); return normalized; }
function validateQuote(quote: MarketQuote, maxAgeMs: number): void { if (!quote.symbol || !Number.isFinite(quote.price) || quote.price < 0 || !quote.currency || !quote.source || !quote.asOf) throw new Error("Market provider returned incomplete or invalid quote data."); const age = Date.now() - Date.parse(quote.asOf); if (!Number.isFinite(age) || age < -60_000 || age > maxAgeMs) throw new Error(`Market quote is stale or has an invalid timestamp (max age ${maxAgeMs}ms).`); }
function toIsoTimestamp(value: string, timezone: string): string { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) return ""; return new Date(parsed).toISOString(); }
