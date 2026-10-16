/**
 * A local turn fence for Live PCM playback. It never cancels a desktop task,
 * modifies the microphone, or claims to cancel generation at the provider.
 */
export class VoicePlaybackPolicy {
  private latestTurn = 0;
  private discardThrough = -1;

  observeUserTurn(value: unknown): void {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      this.latestTurn = Math.max(this.latestTurn, value);
    }
  }

  shouldPlay(value: unknown): boolean {
    const turn = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : this.latestTurn;
    // Reordered transport packets from an older answer must not resume speech
    // after a newer answer has started, even without a manual stop.
    if (turn < this.latestTurn) return false;
    this.observeUserTurn(turn);
    return turn > this.discardThrough;
  }

  shouldInterrupt(value: unknown): boolean {
    return typeof value !== "number" || !Number.isSafeInteger(value) || value >= this.latestTurn;
  }

  stop(): number {
    this.discardThrough = Math.max(this.discardThrough, this.latestTurn);
    return this.discardThrough;
  }

  reset(): void {
    this.latestTurn = 0;
    this.discardThrough = -1;
  }
}

/** If playback falls many seconds behind, halt the turn rather than speaking stale output. */
export function playbackIsStale(secondsAhead: number, sourceCount: number): boolean {
  return secondsAhead > 3 || sourceCount >= 128;
}
