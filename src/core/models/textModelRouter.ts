import { GoogleGenAI } from "@google/genai";
import { isLoopbackHost } from "../../security/requestGuards";
import { readSseData, SseFrameError } from "./sseStream";

export type TextModelRole = "chat" | "planning" | "coding" | "research" | "reasoning" | "summarization" | "verification" | "creation";
export type TextProviderName = "gemini" | "openai-compatible" | "openai" | "anthropic";
export type ModelErrorCode = "NOT_CONFIGURED" | "RATE_LIMIT" | "TIMEOUT" | "NETWORK" | "REJECTED" | "INVALID_RESPONSE" | "BUDGET_EXCEEDED";

/** Errors are deliberately categorical; provider bodies/URLs can contain secrets. */
export class ModelError extends Error {
  constructor(public readonly code: ModelErrorCode, public readonly retryable = false,
    public readonly retryAfterMs?: number) {
    super({
      NOT_CONFIGURED: "The selected text model is not configured.",
      RATE_LIMIT: "The text model is rate limited. Try again later.",
      TIMEOUT: "The text model timed out.",
      NETWORK: "The text model could not be reached.",
      REJECTED: "The text model rejected the request. Check the model and account configuration.",
      INVALID_RESPONSE: "The text model did not return a usable response.",
      BUDGET_EXCEEDED: "The configured text model usage limit has been reached.",
    }[code]);
    this.name = "ModelError";
  }
}

export interface TextModelRequest {
  role: TextModelRole;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
}

export interface TextModelResult {
  text: string;
  provider: TextProviderName;
  model: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  estimatedCostUsd?: number;
}

export interface TextModelAdapter {
  readonly name: TextProviderName;
  available(): boolean;
  generate(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }): Promise<{ text: string; usage?: TextModelResult["usage"] }>;
  /** Optional genuine provider delta stream. Absence means one final text result, not synthetic chunks. */
  stream?(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, onText: (delta: string) => void): Promise<{ text: string; usage?: TextModelResult["usage"] }>;
}

export interface TextModelConfiguration {
  roles: Record<TextModelRole, { provider: TextProviderName; model: string }>;
  timeoutMs: number;
  maxOutputTokens: number;
  maxTotalOutputTokens: number;
  maxAttempts: number;
  /** Optional session budget. If configured, missing user-supplied pricing fails closed. */
  maxEstimatedUsd?: number;
  pricesUsdPerMillion?: Partial<Record<TextProviderName, { input: number; output: number }>>;
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function textModelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TextModelConfiguration {
  const providers: TextProviderName[] = ["gemini", "openai", "anthropic", "openai-compatible"];
  const choose = (value: string | undefined, fallback: TextProviderName): TextProviderName => {
    if (!value?.trim()) return fallback;
    if (!providers.includes(value.trim() as TextProviderName)) throw new Error("Unsupported text provider configuration.");
    return value.trim() as TextProviderName;
  };
  const provider = choose(env.SARA_TEXT_PROVIDER, "gemini");
  const defaultModel = env.SARA_TEXT_MODEL?.trim() || (provider === "gemini" ? "gemini-3.5-flash" : "");
  const role = (prefix: string): { provider: TextProviderName; model: string } => {
    const selected = choose(env[`SARA_${prefix}_PROVIDER`], provider);
    return { provider: selected, model: env[`SARA_${prefix}_MODEL`]?.trim() || (selected === provider ? defaultModel : selected === "gemini" ? "gemini-3.5-flash" : "") };
  };
  const prices: TextModelConfiguration["pricesUsdPerMillion"] = {};
  for (const name of providers) {
    const tag = name.replace(/-/g, "_").toUpperCase();
    const input = env[`SARA_${tag}_INPUT_USD_PER_MILLION`];
    const output = env[`SARA_${tag}_OUTPUT_USD_PER_MILLION`];
    if (input !== undefined || output !== undefined) {
      if (!input || !output || !Number.isFinite(Number(input)) || !Number.isFinite(Number(output)) ||
          Number(input) < 0 || Number(output) < 0 || Number(input) > 10_000 || Number(output) > 10_000) {
        throw new Error("Both bounded pricing rates are required for configured provider cost tracking.");
      }
      prices[name] = { input: Number(input), output: Number(output) };
    }
  }
  const usd = env.SARA_TEXT_MAX_ESTIMATED_USD;
  if (usd !== undefined && usd !== "" && (!Number.isFinite(Number(usd)) || Number(usd) < 0 || Number(usd) > 10_000)) {
    throw new Error("Invalid estimated-cost budget.");
  }
  return {
    roles: { chat: role("CHAT"), planning: role("PLANNING"), coding: role("CODING"), research: role("RESEARCH"),
      reasoning: role("REASONING"), summarization: role("SUMMARIZATION"), verification: role("VERIFICATION"),
      creation: role("CREATION") },
    timeoutMs: boundedNumber(env.SARA_TEXT_TIMEOUT_MS, 20_000, 1_000, 60_000),
    maxOutputTokens: boundedNumber(env.SARA_TEXT_MAX_OUTPUT_TOKENS, 1024, 64, 4096),
    maxTotalOutputTokens: boundedNumber(env.SARA_TEXT_OUTPUT_BUDGET, 50_000, 64, 1_000_000),
    maxAttempts: boundedNumber(env.SARA_TEXT_MAX_ATTEMPTS, 2, 1, 3),
    maxEstimatedUsd: usd !== undefined && usd !== "" ? Number(usd) : undefined,
    pricesUsdPerMillion: prices,
  };
}

function classify(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof SseFrameError) return new ModelError("INVALID_RESPONSE");
  if (error instanceof Error && error.name === "AbortError") return new ModelError("TIMEOUT");
  const message = String(error instanceof Error ? error.message : "").toLowerCase();
  if (/\b429\b|resource.exhausted|rate.limit|quota/.test(message)) return new ModelError("RATE_LIMIT", true);
  if (/\b503\b|\b502\b|unavailable/.test(message)) return new ModelError("NETWORK", true);
  if (/timeout|timed out/.test(message)) return new ModelError("TIMEOUT");
  if (/network|fetch failed|econnrefused|enotfound|econnreset/.test(message)) return new ModelError("NETWORK");
  return new ModelError("REJECTED");
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModelError("TIMEOUT");
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw new ModelError("INVALID_RESPONSE");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function responseFailure(response: Response): ModelError {
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const parsed = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : undefined;
    return new ModelError("RATE_LIMIT", parsed === undefined || parsed <= 2_000,
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
  }
  return new ModelError(response.status === 502 || response.status === 503 ? "NETWORK" : "REJECTED",
    response.status === 502 || response.status === 503);
}

export class TextModelRouter {
  private reservedTokens = 0;
  private usedTokens = 0;
  private reservedUsd = 0;
  private spentUsd = 0;
  private readonly ledger = new Map<TextProviderName, { successes: number; failures: number;
    lastLatencyMs?: number; lastError?: ModelErrorCode; estimatedCostUsd: number }>();
  private readonly adapters: Map<TextProviderName, TextModelAdapter>;

  constructor(public readonly config: TextModelConfiguration, adapters: TextModelAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  }

  private reserveCost(provider: TextProviderName, request: TextModelRequest, maxOutputTokens: number) {
    const price = this.config.pricesUsdPerMillion?.[provider];
    if (this.config.maxEstimatedUsd !== undefined && !price) throw new ModelError("BUDGET_EXCEEDED");
    if (!price) return { estimate: 0, inputEstimate: 0 };
    // Conservative estimate while no token-count endpoint is available.
    const inputEstimate = Math.ceil((request.prompt.length + (request.system?.length || 0)) / 3) + 50;
    const estimate = (inputEstimate * price.input + maxOutputTokens * price.output) * this.config.maxAttempts / 1_000_000;
    if (this.config.maxEstimatedUsd !== undefined &&
        this.spentUsd + this.reservedUsd + estimate > this.config.maxEstimatedUsd) throw new ModelError("BUDGET_EXCEEDED");
    this.reservedUsd += estimate;
    return { estimate, inputEstimate };
  }

  private recordSuccess(provider: TextProviderName, durationMs: number,
    usage: TextModelResult["usage"], maxOutputTokens: number, inputEstimate: number, attempts = 1): number | undefined {
    const price = this.config.pricesUsdPerMillion?.[provider];
    const validInput = Number.isFinite(usage?.inputTokens) && (usage?.inputTokens ?? -1) >= 0;
    const validOutput = Number.isFinite(usage?.outputTokens) && (usage?.outputTokens ?? -1) >= 0;
    const input = validInput ? Number(usage?.inputTokens) : inputEstimate;
    const output = validOutput ? Number(usage?.outputTokens) : maxOutputTokens;
    // A failed retry may still incur charges; account for it conservatively.
    const cost = price ? (input * price.input + output * price.output +
      (attempts - 1) * (inputEstimate * price.input + maxOutputTokens * price.output)) / 1_000_000 : undefined;
    if (cost !== undefined) this.spentUsd += cost;
    const previous = this.ledger.get(provider) || { successes: 0, failures: 0, estimatedCostUsd: 0 };
    this.ledger.set(provider, { ...previous, successes: previous.successes + 1,
      lastLatencyMs: durationMs, lastError: undefined,
      estimatedCostUsd: previous.estimatedCostUsd + (cost ?? 0) });
    return cost;
  }

  private recordFailure(provider: TextProviderName, error: ModelError) {
    const previous = this.ledger.get(provider) || { successes: 0, failures: 0, estimatedCostUsd: 0 };
    this.ledger.set(provider, { ...previous, failures: previous.failures + 1, lastError: error.code });
  }

  status(role: TextModelRole = "chat") {
    const selected = this.config.roles[role];
    const metrics = this.ledger.get(selected.provider);
    return {
      provider: selected.provider,
      model: selected.model,
      configured: Boolean(selected.model && this.adapters.get(selected.provider)?.available()),
      connection: metrics?.successes ? "succeeded" : metrics?.failures ? "failed" : "untested",
      lastError: metrics?.lastError, lastLatencyMs: metrics?.lastLatencyMs,
      estimatedCostUsd: this.config.pricesUsdPerMillion?.[selected.provider] ? metrics?.estimatedCostUsd || 0 : null,
      estimatedCostBudgetUsd: this.config.maxEstimatedUsd ?? null,
      outputTokensUsed: this.usedTokens,
      outputTokenBudget: this.config.maxTotalOutputTokens,
    };
  }

  providerStatuses() {
    return (["gemini", "openai", "anthropic", "openai-compatible"] as const).map((provider) => {
      const roles = (Object.keys(this.config.roles) as TextModelRole[]).filter((role) => this.config.roles[role].provider === provider);
      const metrics = this.ledger.get(provider);
      return { provider, configured: Boolean(this.adapters.get(provider)?.available() && roles.some((role) => !!this.config.roles[role].model)),
        connection: metrics?.successes ? "succeeded" : metrics?.failures ? "failed" : "untested",
        roles, lastError: metrics?.lastError, lastLatencyMs: metrics?.lastLatencyMs,
        callsSucceeded: metrics?.successes || 0, callsFailed: metrics?.failures || 0,
        estimatedCostUsd: this.config.pricesUsdPerMillion?.[provider] ? metrics?.estimatedCostUsd || 0 : null };
    });
  }

  async generate(request: TextModelRequest): Promise<TextModelResult> {
    const selected = this.config.roles[request.role];
    const adapter = this.adapters.get(selected.provider);
    if (!selected.model || !adapter?.available()) throw new ModelError("NOT_CONFIGURED");
    if (!request.prompt || request.prompt.length > 64_000) throw new ModelError("INVALID_RESPONSE");
    const maxOutputTokens = Math.min(this.config.maxOutputTokens, Math.max(1, Math.floor(request.maxOutputTokens || this.config.maxOutputTokens)));
    if (this.reservedTokens + this.usedTokens + maxOutputTokens > this.config.maxTotalOutputTokens) throw new ModelError("BUDGET_EXCEEDED");
    const { estimate, inputEstimate } = this.reserveCost(selected.provider, request, maxOutputTokens);
    this.reservedTokens += maxOutputTokens;
    const started = Date.now();
    try {
      let failure: ModelError = new ModelError("NETWORK");
      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
        aborted(request.signal);
        try {
          const result = await adapter.generate({
            ...request,
            model: selected.model,
            maxOutputTokens,
            timeoutMs: this.config.timeoutMs,
          });
          aborted(request.signal);
          const text = result.text?.trim();
          if (!text) throw new ModelError("INVALID_RESPONSE");
          if (request.responseFormat === "json") {
            try { JSON.parse(text); } catch { throw new ModelError("INVALID_RESPONSE"); }
          }
          const used = Number(result.usage?.outputTokens);
          this.usedTokens += Number.isFinite(used) && used > 0 ? Math.min(maxOutputTokens, used) : maxOutputTokens;
          const durationMs = Date.now() - started;
          const estimatedCostUsd = this.recordSuccess(selected.provider, durationMs, result.usage, maxOutputTokens, inputEstimate, attempt);
          return { ...result, text, model: selected.model, provider: selected.provider, durationMs, estimatedCostUsd };
        } catch (cause) {
          failure = classify(cause);
          if (!failure.retryable || attempt === this.config.maxAttempts || request.signal?.aborted) break;
          await new Promise<void>((resolve) => setTimeout(resolve, failure.retryAfterMs ?? 150 * attempt));
        }
      }
      this.recordFailure(selected.provider, failure);
      throw failure;
    } finally {
      this.reservedTokens -= maxOutputTokens;
      this.reservedUsd -= estimate;
    }
  }

  /** Retry only before any text has been delivered. Partial output is never replayed or persisted. */
  async stream(request: TextModelRequest, onText: (delta: string) => void): Promise<TextModelResult & { streamed: boolean }> {
    const selected = this.config.roles[request.role];
    const adapter = this.adapters.get(selected.provider);
    if (!selected.model || !adapter?.available()) throw new ModelError("NOT_CONFIGURED");
    if (!request.prompt || request.prompt.length > 64_000 || request.responseFormat === "json") throw new ModelError("INVALID_RESPONSE");
    const maxOutputTokens = Math.min(this.config.maxOutputTokens, Math.max(1, Math.floor(request.maxOutputTokens || this.config.maxOutputTokens)));
    if (this.reservedTokens + this.usedTokens + maxOutputTokens > this.config.maxTotalOutputTokens) throw new ModelError("BUDGET_EXCEEDED");
    const { estimate, inputEstimate } = this.reserveCost(selected.provider, request, maxOutputTokens);
    this.reservedTokens += maxOutputTokens;
    const started = Date.now();
    let delivered = false;
    let length = 0;
    try {
      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
        aborted(request.signal);
        try {
          const options = { ...request, model: selected.model, maxOutputTokens, timeoutMs: this.config.timeoutMs };
          const result = adapter.stream
            ? await adapter.stream(options, (delta) => {
                aborted(request.signal);
                if (typeof delta !== "string") throw new ModelError("INVALID_RESPONSE");
                length += delta.length;
                if (length > Math.max(8_192, maxOutputTokens * 16)) throw new ModelError("INVALID_RESPONSE");
                if (delta) { delivered = true; onText(delta); }
              })
            : await adapter.generate(options);
          aborted(request.signal);
          const text = result.text?.trim();
          if (!text) throw new ModelError("INVALID_RESPONSE");
          if (!adapter.stream) {
            delivered = true;
            onText(text); // explicitly marked non-streaming in the result
          }
          const used = Number(result.usage?.outputTokens);
          this.usedTokens += Number.isFinite(used) && used > 0 ? Math.min(maxOutputTokens, used) : maxOutputTokens;
          const durationMs = Date.now() - started;
          const estimatedCostUsd = this.recordSuccess(selected.provider, durationMs, result.usage, maxOutputTokens, inputEstimate, attempt);
          return { ...result, text, model: selected.model, provider: selected.provider,
            durationMs, streamed: Boolean(adapter.stream), estimatedCostUsd };
        } catch (cause) {
          const failure = classify(cause);
          if (delivered) {
            // Conservative accounting: we may have been charged even if the
            // network/client dropped before the provider reported token usage.
            this.usedTokens += maxOutputTokens;
          }
          if (delivered || !failure.retryable || attempt === this.config.maxAttempts || request.signal?.aborted) {
            this.recordFailure(selected.provider, failure);
            throw failure;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, failure.retryAfterMs ?? 150 * attempt));
        }
      }
      throw new ModelError("NETWORK");
    } finally {
      this.reservedTokens -= maxOutputTokens;
      this.reservedUsd -= estimate;
    }
  }
}

type GeminiClient = Pick<GoogleGenAI, "models">;

export class GeminiTextAdapter implements TextModelAdapter {
  readonly name = "gemini" as const;
  constructor(
    private readonly getKey: () => string | undefined,
    private readonly createClient: (key: string, timeoutMs: number) => GeminiClient = (key, timeoutMs) => new GoogleGenAI({ apiKey: key, httpOptions: { timeout: timeoutMs } }),
  ) {}

  available(): boolean { return Boolean(this.getKey()?.trim()); }

  async generate(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }) {
    const key = this.getKey()?.trim();
    if (!key) throw new ModelError("NOT_CONFIGURED");
    const config = {
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0.7,
      ...(request.system ? { systemInstruction: request.system } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
      ...(request.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
    };
    try {
      const response = await this.createClient(key, request.timeoutMs).models.generateContent({
        model: request.model,
        contents: request.prompt,
        config,
      });
      return { text: response.text || "", usage: { inputTokens: response.usageMetadata?.promptTokenCount, outputTokens: response.usageMetadata?.candidatesTokenCount } };
    } catch (error) {
      throw classify(error);
    }
  }

  async stream(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, onText: (delta: string) => void) {
    const key = this.getKey()?.trim();
    if (!key) throw new ModelError("NOT_CONFIGURED");
    const config = {
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0.7,
      ...(request.system ? { systemInstruction: request.system } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
    };
    let text = "";
    let usage: TextModelResult["usage"] | undefined;
    try {
      const chunks = await this.createClient(key, request.timeoutMs).models.generateContentStream({
        model: request.model, contents: request.prompt, config,
      });
      for await (const chunk of chunks) {
        aborted(request.signal);
        if (chunk.text) { text += chunk.text; onText(chunk.text); }
        if (chunk.usageMetadata) usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
        };
      }
      return { text, usage };
    } catch (error) { throw classify(error); }
  }
}

/** Server-configured OpenAI-compatible API (including loopback inference servers). */
export class CompatibleTextAdapter implements TextModelAdapter {
  readonly name: TextProviderName = "openai-compatible";
  private readonly endpoint: URL | null;
  constructor(
    baseUrl: string,
    private readonly apiKey = "",
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!baseUrl.trim()) { this.endpoint = null; return; }
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol) ||
        (url.protocol === "http:" && !isLoopbackHost(url.hostname))) {
      throw new Error("Text model base URL must use HTTPS or local loopback HTTP, without credentials or query parameters.");
    }
    this.endpoint = new URL(`${url.pathname.replace(/\/$/, "")}/chat/completions`, url);
  }

  available(): boolean { return this.endpoint !== null; }

  async generate(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }) {
    if (!this.endpoint) throw new ModelError("NOT_CONFIGURED");
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: request.model,
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }],
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.7,
          ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
        }),
        signal,
      });
    } catch {
      throw new ModelError(signal.aborted ? "TIMEOUT" : "NETWORK");
    }
    // Never return the provider's error body; it may echo the Authorization header.
    if (!response.ok) throw responseFailure(response);
    try {
      const payload = await boundedJson(response) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (typeof payload.choices?.[0]?.message?.content !== "string") throw new Error("missing content");
      return {
        text: payload.choices[0].message.content,
        usage: { inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens },
      };
    } catch {
      throw new ModelError("INVALID_RESPONSE");
    }
  }

  async stream(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, onText: (delta: string) => void) {
    if (!this.endpoint) throw new ModelError("NOT_CONFIGURED");
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: request.model, stream: true,
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }],
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.7,
        }),
      });
    } catch {
      throw new ModelError(signal.aborted ? "TIMEOUT" : "NETWORK");
    }
    if (!response.ok) throw responseFailure(response);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
      throw new ModelError("INVALID_RESPONSE");
    }
    let text = "";
    let done = false;
    let usage: TextModelResult["usage"] | undefined;
    try {
      await readSseData(response.body, (data, eventType) => {
        if (eventType === "error") throw new ModelError("REJECTED");
        if (data === "[DONE]") { done = true; return; }
        if (done) throw new ModelError("INVALID_RESPONSE");
        let payload: { choices?: Array<{ delta?: { content?: unknown } }>; usage?: { completion_tokens?: number; prompt_tokens?: number } };
        try { payload = JSON.parse(data); }
        catch { throw new ModelError("INVALID_RESPONSE"); }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) { text += delta; onText(delta); }
        if (payload.usage) usage = { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens };
      });
    } catch (error) { throw signal.aborted ? new ModelError("TIMEOUT") : classify(error); }
    if (!done) throw new ModelError("NETWORK"); // EOF without a provider completion marker is partial, not success.
    return { text, usage };
  }
}

/** Official OpenAI Chat Completions endpoint; credentials never leave the backend. */
export class OpenAITextAdapter extends CompatibleTextAdapter {
  override readonly name = "openai" as const;
  constructor(private readonly key: string, fetcher: typeof fetch = fetch) {
    super("https://api.openai.com/v1", key, fetcher);
  }
  override available(): boolean { return Boolean(this.key.trim()); }
}

/** Official Anthropic Messages API; responses are proposals, never tool authority. */
export class AnthropicTextAdapter implements TextModelAdapter {
  readonly name = "anthropic" as const;
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  available(): boolean { return Boolean(this.key.trim()); }

  private requestBody(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, stream: boolean) {
    return JSON.stringify({ model: request.model, max_tokens: request.maxOutputTokens,
      messages: [{ role: "user", content: request.prompt }],
      ...(request.system || request.responseFormat === "json" ? { system: [request.system || "",
        ...(request.responseFormat === "json" ? ["Return exactly one JSON object and no other text."] : [])].filter(Boolean).join("\n") } : {}),
      ...(stream ? { stream: true } : {}),
      temperature: request.temperature ?? 0.7 });
  }
  private async send(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, stream: boolean): Promise<{ response: Response; signal: AbortSignal }> {
    if (!this.available()) throw new ModelError("NOT_CONFIGURED");
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", "x-api-key": this.key,
          "anthropic-version": "2023-06-01" },
        body: this.requestBody(request, stream),
      });
    } catch { throw new ModelError(signal.aborted ? "TIMEOUT" : "NETWORK"); }
    if (!response.ok) throw responseFailure(response);
    return { response, signal };
  }
  async generate(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }) {
    const { response, signal } = await this.send(request, false);
    try {
      const payload = await boundedJson(response) as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!Array.isArray(payload.content) || !["end_turn", "stop_sequence"].includes(payload.stop_reason || "")) throw new ModelError("INVALID_RESPONSE");
      const text = payload.content.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text).join("");
      if (!text) throw new ModelError("INVALID_RESPONSE");
      return { text, usage: { inputTokens: payload.usage?.input_tokens, outputTokens: payload.usage?.output_tokens } };
    } catch (error) { throw signal.aborted ? new ModelError("TIMEOUT") : classify(error); }
  }
  async stream(request: Omit<TextModelRequest, "role"> & { model: string; timeoutMs: number }, onText: (delta: string) => void) {
    const { response, signal } = await this.send(request, true);
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new ModelError("INVALID_RESPONSE");
    let text = ""; let done = false; let stopReason = "";
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    try {
      await readSseData(response.body, (data, eventType) => {
        let payload: any;
        try { payload = JSON.parse(data); } catch { throw new ModelError("INVALID_RESPONSE"); }
        if (eventType === "error") throw new ModelError(payload.error?.type === "rate_limit_error" ? "RATE_LIMIT" : "REJECTED");
        if (done || !payload || typeof payload !== "object") throw new ModelError("INVALID_RESPONSE");
        if (eventType === "message_start") usage.inputTokens = payload.message?.usage?.input_tokens;
        if (eventType === "content_block_delta" && payload.delta?.type === "text_delta") {
          if (typeof payload.delta.text !== "string") throw new ModelError("INVALID_RESPONSE");
          text += payload.delta.text; onText(payload.delta.text);
        }
        if (eventType === "message_delta") {
          usage.outputTokens = payload.usage?.output_tokens;
          stopReason = payload.delta?.stop_reason || "";
        }
        if (eventType === "message_stop") done = true;
      });
    } catch (error) { throw signal.aborted ? new ModelError("TIMEOUT") : classify(error); }
    if (!done || !["end_turn", "stop_sequence"].includes(stopReason)) throw new ModelError("INVALID_RESPONSE");
    return { text, usage };
  }
}

/** Instantiate only on the backend, after dotenv.config(); no key is sent to browsers. */
export function createTextModelRouter(getGeminiKey: () => string | undefined, env: NodeJS.ProcessEnv = process.env): TextModelRouter {
  return new TextModelRouter(textModelConfigFromEnv(env), [
    new GeminiTextAdapter(getGeminiKey),
    new OpenAITextAdapter(env.OPENAI_API_KEY || ""),
    new AnthropicTextAdapter(env.ANTHROPIC_API_KEY || ""),
    new CompatibleTextAdapter(env.SARA_TEXT_API_BASE_URL || "", env.SARA_TEXT_API_KEY || ""),
  ]);
}
