// src/services/adapters/MithosAdapter.ts
import axios from "axios";
import { LLMAdapter, ChatMessage, ChatOptions, ChatResponse } from "../LLMAdapter";
import { getModelConfig } from "../../config/models";

/** Adapter for the hypothetical Mithos service. */
export class MithosAdapter implements LLMAdapter {
  private readonly config = getModelConfig("mithos");
  private readonly apiKey: string | undefined;

  constructor() {
    if (this.config) {
      this.apiKey = process.env[this.config.apiKeyEnv];
    }
  }

  private async request<T>(path: string, payload: any): Promise<T> {
    if (!this.config) throw new Error("Mithos model config not found");
    const url = `${this.config.apiUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const resp = await axios.post<T>(url, payload, { headers });
    return resp.data;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const payload = { messages, ...options };
    return this.request<ChatResponse>("/chat", payload);
  }

  async runAdvancedReasoning(prompt: string): Promise<string> {
    const payload = { prompt };
    const result = await this.request<{ answer: string }>("/reason", payload);
    return result.answer;
  }

  async generatePatch(description: string): Promise<string> {
    const payload = { description, mode: "code" };
    const result = await this.request<{ diff: string }>("/code", payload);
    return result.diff;
  }
}
