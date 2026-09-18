// src/config/models.ts
/**
 * Configuration for external LLM back‑ends.
 * Each model is defined with an identifier, a friendly name, the base API URL,
 * and the environment variable name that holds its secret key.
 *
 * The actual secret values are **not** hard‑coded – they are loaded from process.env
 * at runtime (e.g., via a .env file). This complies with the request to omit API keys
 * from the source code.
 */
export interface ModelConfig {
  /** Unique identifier used throughout the app */
  id: string;
  /** Human‑readable name shown in the UI */
  name: string;
  /** Base HTTP endpoint for the model’s chat/completion API */
  apiUrl: string;
  /** Environment variable that stores the API key for this model */
  apiKeyEnv: string;
}

// Define the available models. Replace the placeholder URLs with the real
// endpoints when you configure the deployment.
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: "astra",
    name: "GPT‑6 Astra",
    apiUrl: "https://api.astra.example.com/v1/chat",
    apiKeyEnv: "ASTRA_API_KEY",
  },
  {
    id: "fable5",
    name: "Fable 5",
    apiUrl: "https://api.fable5.example.com/v1/chat",
    apiKeyEnv: "FABLE5_API_KEY",
  },
  {
    id: "mithos",
    name: "Mithos",
    apiUrl: "https://api.mithos.example.com/v1/chat",
    apiKeyEnv: "MITHOS_API_KEY",
  },
];

/**
 * Helper to resolve a model configuration by its identifier.
 */
export function getModelConfig(id: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}
