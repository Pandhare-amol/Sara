import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from '../config/env';

/**
 * LLMService – thin wrapper around Google Gemini 1.5 Pro.
 * Provides standard and advanced‑reasoning calls.
 */
export class LLMService {
  private client: GoogleGenAI;
  private lastUsage: { inputTokens: number; outputTokens: number } | null = null;

  constructor(apiKey = GEMINI_API_KEY || "") {
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Standard call – uses flash model, suitable for everyday tasks */
  async runStandard(prompt: string, options: any = {}): Promise<string> {
    const response = await this.client.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: options });
    this.captureTokenUsage(response);
    return String(response.text || '');
  }

  /** Advanced reasoning call – uses the 1.5 Pro model with reasoning‑optimized params */
  async runAdvancedReasoning(prompt: string, options: any = {}): Promise<string> {
    // Switch to the Pro model (larger context, higher reasoning)
    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0.2, maxOutputTokens: 8192, ...options },
    });
    this.captureTokenUsage(response);
    return String(response.text || '');
  }

  /** Return token usage from the most recent request */
  getTokenUsage() {
    return this.lastUsage;
  }

  private captureTokenUsage(response: any) {
    // The response object from @google/genai contains usage stats
    const usage = response?.usage?.candidates?.[0]?.
      tokenCount || response?.usage?.tokenCount;
    if (usage) {
      this.lastUsage = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
    }
  }
}
