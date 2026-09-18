// src/self_improvement/CodeGenerationService.ts

/**
 * Service responsible for generating code snippets using the Gemini LLM.
 * It receives a natural‑language description of the task and optional context
 * (e.g., imported modules, existing code snippets) and returns a string
 * containing the generated TypeScript / JavaScript code.
 */

import { GoogleGenAI, Type } from "@google/genai";

export interface CodeGenOptions {
  /** The model to use – defaults to Gemini 1.5 flash. */
  model?: string;
  /** Additional system instruction to influence style, security, etc. */
  systemInstruction?: string;
  /** Optional JSON schema describing the expected output. */
  responseSchema?: any;
}

export class CodeGenerationService {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Generate code based on a description and optional context.
   * Returns a plain string containing the code.
   */
  async generateCode(taskDescription: string, context?: string, options?: CodeGenOptions): Promise<string> {
    const model = options?.model ?? "gemini-1.5-flash";
    const systemInstruction = options?.systemInstruction ?? "You are SARA, an autonomous AI coding assistant. Generate clean, functional TypeScript/JavaScript code that follows best practices and includes necessary imports. Do not fabricate external dependencies that are not available in the project.";

    const prompt = `Task Description:\n${taskDescription}\n\nContext (existing code or imports):\n${context ?? "None"}`;

    const response = await this.ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: options?.responseSchema ?? {
          type: Type.OBJECT,
          properties: {
            code: { type: Type.STRING, description: "The generated code snippet" },
          },
          required: ["code"],
        },
      },
    });

    if (!response.text) {
      throw new Error("Code generation failed – no response text");
    }
    const parsed = JSON.parse(response.text);
    return parsed.code as string;
  }
}
