// src/self_improvement/PatchGenerator.ts
import { RuntimeHealthSnapshot } from "./PerformanceMonitor";
import { EventBus } from "../core/events/EventBus";

/**
 * Generates a code patch suggestion based on a runtime health snapshot.
 * In production this would call an LLM (e.g., OpenAI gpt-4o). Here we provide a minimal stub
 * that returns null when no suggestion is generated.
 */
export class PatchGenerator {
  private readonly llmEndpoint: string;
  private readonly apiKey: string;
  private unavailableUntil = 0;

  constructor() {
    this.llmEndpoint = process.env.SELF_IMPROVEMENT_LLM_ENDPOINT || "https://api.openai.com/v1/chat/completions";
    this.apiKey = process.env.OPENAI_API_KEY || "";
  }

  /**
   * Generate a patch suggestion for the given module.
   * @param modulePath absolute path to the source file
   * @param snapshot runtime health snapshot
   * @returns a patch suggestion or null if none
   */
  async generatePatch(modulePath: string, snapshot: RuntimeHealthSnapshot): Promise<{ file: string; diff: string; description: string } | null> {
    if (!this.apiKey || Date.now() < this.unavailableUntil) return null;

    const prompt = `You are an expert TypeScript engineer for the SARA platform.\nBased on the following performance snapshot for ${modulePath}:\n${JSON.stringify(snapshot, null, 2)}\nSuggest a small code change (as a unified diff) that could improve CPU, memory or event‑loop lag. Return a description and the diff. If no change is needed, respond with null.`;
    try {
      const resp = await fetch(this.llmEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content as string | undefined;
      if (!content) return null;
      const diffMatch = content.match(/```diff\n([\s\S]*?)\n```/);
      const descMatch = content.match(/Description:\s*(.*)/i);
      if (!diffMatch) return null;
      const diff = diffMatch[1].trim();
      const description = descMatch ? descMatch[1].trim() : "Auto‑generated improvement";
      const suggestion = { file: modulePath, diff, description };
      EventBus.instance.emitEvent("patchGenerated", suggestion);
      return suggestion;
    } catch (e) {
      this.unavailableUntil = Date.now() + 60_000;
      console.warn("PatchGenerator temporarily unavailable; retrying in 60 seconds.", e);
      return null;
    }
  }
}
