export type PlaybackState = "IDLE" | "PLAYING" | "PAUSED" | "STOPPED" | "FAILED";
export type PlaybackListener = (state: PlaybackState) => void;

export class AudioPlaybackManager {
  private audio: HTMLAudioElement | null = null;
  private state: PlaybackState = "IDLE";
  private readonly listeners = new Set<PlaybackListener>();

  on(listener: PlaybackListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getPlaybackState(): PlaybackState { return this.state; }
  getCurrentTrack(): string | null { return this.audio?.src || null; }
  private setState(state: PlaybackState): void { this.state = state; this.listeners.forEach((listener) => listener(state)); }

  async play(source: string): Promise<void> {
    this.stop();
    if (typeof Audio === "undefined") throw new Error("AUDIO_PLAYBACK_UNAVAILABLE: Browser audio is unavailable.");
    const audio = new Audio(source);
    this.audio = audio;
    audio.addEventListener("ended", () => this.setState("STOPPED"), { once: true });
    audio.addEventListener("error", () => this.setState("FAILED"), { once: true });
    await audio.play();
    this.setState("PLAYING");
  }
  pause(): void { this.audio?.pause(); if (this.audio) this.setState("PAUSED"); }
  async resume(): Promise<void> { if (!this.audio) return; await this.audio.play(); this.setState("PLAYING"); }
  stop(): void { if (!this.audio) return; this.audio.pause(); this.audio.currentTime = 0; this.audio = null; this.setState("STOPPED"); }
  setVolume(value: number): void { if (this.audio) this.audio.volume = Math.max(0, Math.min(1, value)); }
}
