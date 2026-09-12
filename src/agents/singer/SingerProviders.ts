import fs from "node:fs/promises";
import path from "node:path";
import type { AudioResult, SingingProvider } from "./SingerTypes";

export class SingerProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

export class UnavailableSingingProvider implements SingingProvider {
  readonly id = "unavailable";
  async generateVocals(): Promise<AudioResult> { throw new SingerProviderError("SINGER_PROVIDER_UNAVAILABLE", "No production singing provider is configured. SARA cannot truthfully generate vocals yet."); }
  async generateInstrumental(): Promise<AudioResult> { throw new SingerProviderError("INSTRUMENTAL_PROVIDER_UNAVAILABLE", "No production instrumental provider is configured."); }
}

export class MockSingingProvider implements SingingProvider {
  readonly id = "mock-development-only";
  constructor(private readonly directory = path.resolve(process.cwd(), "data", "singer-test-cache")) {}
  async generateVocals(request: Parameters<SingingProvider["generateVocals"]>[0]): Promise<AudioResult> { return this.writeMarker("vocals", request.plan.duration); }
  async generateInstrumental(request: Parameters<SingingProvider["generateInstrumental"]>[0]): Promise<AudioResult> { return this.writeMarker("instrumental", request.plan.duration); }
  private async writeMarker(kind: string, duration: string): Promise<AudioResult> {
    await fs.mkdir(this.directory, { recursive: true });
    const audioPath = path.join(this.directory, `${kind}-${Date.now()}.test-audio`);
    await fs.writeFile(audioPath, `SARA TEST AUDIO ${kind} ${duration}`, "utf8");
    return { audioPath, mimeType: "application/octet-stream", durationSeconds: duration === "FULL" ? 120 : duration === "MEDIUM" ? 60 : 20, provider: this.id, verified: true };
  }
}

export function createSingingProvider(): SingingProvider {
  const allowMock = process.env.NODE_ENV !== "production" && process.env.SARA_SINGER_MOCK === "true";
  return allowMock ? new MockSingingProvider() : new UnavailableSingingProvider();
}
