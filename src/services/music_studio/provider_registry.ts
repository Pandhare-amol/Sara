import type { MusicProvider } from "./autonomousTypes";

export class MusicProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(`${code}: ${message}`); }
}

export class UnavailableMusicProvider implements MusicProvider {
  readonly id = "unavailable";
  async generateMusic(): Promise<never> { throw new MusicProviderError("MUSIC_PROVIDER_UNAVAILABLE", "No production music generation provider is configured."); }
  async getStatus(): Promise<{ status: "FAILED"; error: string }> { return { status: "FAILED", error: "No production music generation provider is configured." }; }
  async cancel(): Promise<void> { return; }
  async healthCheck(): Promise<{ healthy: false; details: string }> { return { healthy: false, details: "No production music generation provider is configured." }; }
}

export class MusicProviderRegistry {
  private readonly providers = new Map<string, MusicProvider>();
  register(provider: MusicProvider): void { this.providers.set(provider.id, provider); }
  get(id?: string): MusicProvider {
    if (id && this.providers.has(id)) return this.providers.get(id)!;
    const provider = [...this.providers.values()][0];
    if (!provider) throw new MusicProviderError("MUSIC_PROVIDER_UNAVAILABLE", "No music generation provider is registered.");
    return provider;
  }
  async health(): Promise<Array<{ id: string; healthy: boolean; details?: string }>> { return Promise.all([...this.providers.values()].map(async (provider) => ({ id: provider.id, ...(await provider.healthCheck()) }))); }
}

export const musicProviderRegistry = new MusicProviderRegistry();
musicProviderRegistry.register(new UnavailableMusicProvider());