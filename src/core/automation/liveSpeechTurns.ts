/**
 * Provider transcription may arrive before, during, or after its PCM chunks.
 * Audio fencing therefore uses output-turn IDs, never a transcription count.
 * A stopped answer stays suppressed through its final PCM chunk even when a
 * later user transcript arrives; only an actual output boundary opens a new ID.
 * These IDs are local to one Live WebSocket session.
 */
export class LiveSpeechTurns {
  private revision = 0;
  private active: number | null = null;
  private suppressedThrough = -1;

  private beginOutput(): number {
    if (this.active === null) this.active = ++this.revision;
    return this.active;
  }

  audio(): { turn: number; forward: boolean } {
    const turn = this.beginOutput();
    return { turn, forward: turn > this.suppressedThrough };
  }

  /** Transcription is not a new output boundary. */
  userTranscription(): number {
    return this.active ?? this.revision;
  }

  complete(): number {
    const turn = this.active ?? this.revision;
    this.active = null;
    return turn;
  }

  interrupt(): number {
    const turn = this.active ?? this.revision;
    this.suppressedThrough = Math.max(this.suppressedThrough, turn);
    this.active = null;
    return turn;
  }

  /** Speech-only command; never pre-mute a future answer if none is active. */
  stopForCommand(): number {
    const turn = this.active ?? this.revision;
    this.suppressedThrough = Math.max(this.suppressedThrough, turn);
    return turn;
  }

  /** A late client stop cannot suppress an already-started newer response. */
  stopClientTurn(value: unknown): boolean {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > this.revision) return false;
    this.suppressedThrough = Math.max(this.suppressedThrough, value);
    return true;
  }
}
