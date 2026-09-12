# SARA AGI Enhancement Layer

This package is opt-in and independent. Existing UI, server, and functionality do not import it automatically.

```ts
import { AgiService, localProvider } from "./agi";

const agi = new AgiService([localProvider(async (request) => `Local result: ${request.input}`)], { enabled: true });
const result = await agi.generate({ input: "Summarize this", sessionId: "session-1" });
```

Use `openAiProvider`, `anthropicProvider`, or `localProvider` to select a model. Use `createAgiMiddleware`, `createAgiProxy`, or `wrapFunction` at an integration boundary. Set `enabled: false` or call `setEnabled(false)` for a no-op enhancement layer.

`ContextManager` accepts a custom `VectorStore`, allowing IndexedDB, SQLite, or a hosted vector database to be supplied without coupling this package to a storage vendor. The default is an in-memory store for graceful degradation and tests.

## Live Market Data

Use a licensed provider account and keep the key in an environment secret. The account plan controls whether the feed is real-time or delayed:

```ts
import { BusinessLadyService, AgiService, twelveDataProvider } from "./agi";

const marketData = twelveDataProvider({
	apiKey: process.env.TWELVE_DATA_API_KEY!,
	delayed: process.env.TWELVE_DATA_IS_DELAYED !== "false",
});
const businessSara = new BusinessLadyService(new AgiService([], { enabled: true }), {
	enabled: true,
	marketData,
	maxQuoteAgeMs: 120_000,
});
```

The adapter does not guess missing values. It rejects invalid or stale responses, includes the provider and timestamp, and reports data as delayed unless deployment explicitly confirms a real-time entitlement. This is market data, not personalized financial advice.
