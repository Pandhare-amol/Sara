import type { AgiGenerationRequest, AgiProvider } from "./types";

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error(`Model request failed with HTTP ${response.status}`);
    const data = await response.json() as Record<string, any>;
    return String(data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? data.output ?? "");
  } finally {
    clearTimeout(timeout);
  }
}

export function openAiProvider(apiKey: string, model = "gpt-4o-mini", timeoutMs = 20_000): AgiProvider {
  return { name: "openai", generate: (request, systemPrompt) => postJson("https://api.openai.com/v1/chat/completions", { model, messages: [{ role: "system", content: systemPrompt }, ...(request.messages ?? []), { role: "user", content: request.input }], temperature: request.temperature ?? 0.4, max_tokens: request.maxTokens ?? 512 }, { authorization: `Bearer ${apiKey}` }, timeoutMs) };
}

export function anthropicProvider(apiKey: string, model = "claude-3-5-haiku-latest", timeoutMs = 20_000): AgiProvider {
  return { name: "anthropic", generate: (request, systemPrompt) => postJson("https://api.anthropic.com/v1/messages", { model, system: systemPrompt, messages: [...(request.messages ?? []), { role: "user", content: request.input }], max_tokens: request.maxTokens ?? 512, temperature: request.temperature ?? 0.4 }, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, timeoutMs) };
}

export function localProvider(generate: (request: AgiGenerationRequest, systemPrompt: string) => Promise<string>): AgiProvider {
  return { name: "local", generate };
}
