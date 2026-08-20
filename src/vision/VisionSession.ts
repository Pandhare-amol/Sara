export type VisionSessionStatus = "INACTIVE" | "ACTIVE" | "ANALYZING" | "ENDED";

export interface VisionSessionSnapshot {
  sessionId: string;
  startedAt: string;
  status: VisionSessionStatus;
  frameCount: number;
  analysisCount: number;
  lastAnalysis?: string;
  latencyMs?: number;
}

export class VisionSession {
  private readonly snapshot: VisionSessionSnapshot;

  constructor() {
    this.snapshot = {
      sessionId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      status: "ACTIVE",
      frameCount: 0,
      analysisCount: 0,
    };
  }

  recordFrame(): void {
    this.snapshot.frameCount += 1;
  }

  beginAnalysis(): void {
    this.snapshot.status = "ANALYZING";
  }

  finishAnalysis(text: string, latencyMs: number): void {
    this.snapshot.status = "ACTIVE";
    this.snapshot.analysisCount += 1;
    this.snapshot.lastAnalysis = text;
    this.snapshot.latencyMs = latencyMs;
  }

  end(): void {
    this.snapshot.status = "ENDED";
  }

  get value(): VisionSessionSnapshot {
    return { ...this.snapshot };
  }
}
