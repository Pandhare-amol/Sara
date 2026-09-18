// src/services/LLMAdapter.ts
/**
 * Common interface for all LLM back‑ends used by Sara.
 * Each adapter knows how to send a chat/completion request and, for code‑generation tasks,
 * produce a diff (git‑style patch).
 */
export interface LLMAdapter {
  /** Generic chat API – returns a response string (could be JSON, plain text, etc.) */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /** Advanced‑reasoning request – same as before but routed to the model's specialised endpoint. */
  runAdvancedReasoning(prompt: string): Promise<string>;

  /** Generate a code patch given a description. */
  generatePatch(description: string): Promise<string>;
}

// Minimal type definitions used by the adapters (you can expand as needed).
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}
export interface ChatResponse {
  role: string;
  content: string;
}
