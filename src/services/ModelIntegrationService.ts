// src/services/ModelIntegrationService.ts
import { LLMAdapter } from "./LLMAdapter";
import { AstraAdapter } from "./adapters/AstraAdapter";
import { Fable5Adapter } from "./adapters/Fable5Adapter";
import { MithosAdapter } from "./adapters/MithosAdapter";
import { getModelConfig } from "../config/models";
import { loadSettings, saveSettings } from "../lib/settingsStore";

/**
 * Singleton service that routes all LLM calls to the currently selected model.
 * It also exposes a `generatePatch` helper for code‑generation use‑cases.
 */
export class ModelIntegrationService {
  private static _instance: ModelIntegrationService | null = null;
  private adapters: Map<string, LLMAdapter> = new Map();
  private activeId: string;

  private constructor() {
    // Initialise adapters for all known models.
    this.adapters.set("astra", new AstraAdapter());
    this.adapters.set("fable5", new Fable5Adapter());
    this.adapters.set("mithos", new MithosAdapter());

    // Load persisted model selection (default is "astra").
    const settings = loadSettings();
    this.activeId = (settings as any).activeModelId || "astra";
  }

  public static getInstance(): ModelIntegrationService {
    if (!ModelIntegrationService._instance) {
      ModelIntegrationService._instance = new ModelIntegrationService();
    }
    return ModelIntegrationService._instance;
  }

  /** Change the active model and persist the choice. */
  public setActiveModel(id: string): void {
    if (!this.adapters.has(id)) throw new Error(`Model ${id} not registered`);
    this.activeId = id;
    // Persist selection back to settings store.
    saveSettings({ activeModelId: id } as any);
  }

  public getActiveModel(): LLMAdapter {
    const adapter = this.adapters.get(this.activeId);
    if (!adapter) throw new Error(`Active model ${this.activeId} not found`);
    return adapter;
  }

  /** Generic chat call – forwards to the active adapter. */
  public async chat(messages: any[], options?: any): Promise<any> {
    return this.getActiveModel().chat(messages, options);
  }

  /** Advanced‑reasoning call – forwards to the active adapter. */
  public async runAdvancedReasoning(prompt: string): Promise<string> {
    return this.getActiveModel().runAdvancedReasoning(prompt);
  }

  /** Code‑generation call – returns a git‑style diff. */
  public async generatePatch(description: string): Promise<string> {
    return this.getActiveModel().generatePatch(description);
  }
}
