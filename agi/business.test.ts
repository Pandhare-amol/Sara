import test from "node:test";
import assert from "node:assert/strict";
import { AgiService, BusinessLadyService, localProvider, twelveDataProvider } from "./index";

test("Business Lady overlay refuses unverified live market claims", async () => {
  const agi = new AgiService([localProvider(async (request) => request.input)], { enabled: true, storage: "memory" });
  const business = new BusinessLadyService(agi, { enabled: true });
  const result = await business.generate({ input: "What is the current price of AAPL?", sessionId: "s1" });
  assert.match(result?.text ?? "", /MARKET DATA: UNAVAILABLE/);
  await assert.rejects(() => business.quote({ symbol: "AAPL" }), /Live market data is unavailable/);
});

test("Business Lady validates fresh sourced quotes", async () => {
  const business = new BusinessLadyService(new AgiService([], { storage: "memory" }), {
    enabled: true,
    marketData: { name: "test-feed", quote: async ({ symbol }) => ({ symbol, price: 200, currency: "USD", asOf: new Date().toISOString(), source: "test-feed", delayed: false }) },
  });
  const quote = await business.quote({ symbol: "aapl" });
  assert.equal(quote.symbol, "AAPL");
  assert.equal(quote.delayed, false);
});

test("Twelve Data adapter normalizes a real quote response", async () => {
  const provider = twelveDataProvider({ apiKey: "test-key", delayed: false, fetcher: async (input) => {
    assert.match(String(input), /symbol%3F|symbol=AAPL|symbol%3DAAPL/);
    return new Response(JSON.stringify({ symbol: "AAPL", close: "201.25", currency: "USD", change: "1.25", percent_change: "0.62", datetime: new Date().toISOString(), exchange_timezone: "America/New_York" }), { status: 200 });
  } });
  const quote = await provider.quote({ symbol: "aapl" });
  assert.equal(quote.price, 201.25);
  assert.equal(quote.source, "Twelve Data /quote");
  assert.equal(quote.delayed, false);
});

test("Twelve Data adapter surfaces provider errors", async () => {
  const provider = twelveDataProvider({ apiKey: "test-key", fetcher: async () => new Response(JSON.stringify({ status: "error", message: "Invalid API key" }), { status: 401 }) });
  await assert.rejects(() => provider.quote({ symbol: "AAPL" }), /Invalid API key/);
});