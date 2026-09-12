import type { CodeAdapter, MediaAdapter, MediaInput, Modality } from "./advanced-types";

export class MultimodalService {
  private readonly adapters = new Map<Modality, MediaAdapter>();
  register(adapter: MediaAdapter): void { this.adapters.set(adapter.modality, adapter); }
  get(modality: Modality): MediaAdapter | undefined { return this.adapters.get(modality); }
  async understand(input: MediaInput, instruction?: string): Promise<string> {
    const adapter = this.adapters.get(input.modality);
    if (!adapter) throw new Error(`No adapter registered for modality '${input.modality}'. Register one before use.`);
    return adapter.understand(input, instruction);
  }
  async generate(modality: Modality, prompt: string, options?: Record<string, unknown>): Promise<MediaInput> {
    const adapter = this.adapters.get(modality);
    if (!adapter?.generate) throw new Error(`Generation is not supported for modality '${modality}'.`);
    return adapter.generate(prompt, options);
  }
}

export class TextDocumentAdapter implements MediaAdapter {
  readonly modality: "document" = "document";
  async understand(input: MediaInput): Promise<string> {
    if (typeof input.data === "string") return input.data;
    return new TextDecoder().decode(input.data);
  }
}

export class CodeUnderstandingAdapter implements CodeAdapter {
  readonly modality: "code" = "code";
  async understand(input: MediaInput): Promise<string> { return this.explain(typeof input.data === "string" ? input.data : new TextDecoder().decode(input.data), input.metadata?.language as string | undefined); }
  async explain(code: string, language = "unknown"): Promise<string> { return `${language} code received (${code.split("\n").length} lines). Connect a model-backed adapter for semantic explanation.`; }
  async generateCode(specification: string, language: string): Promise<string> { return `// ${language} implementation requested: ${specification}`; }
}
