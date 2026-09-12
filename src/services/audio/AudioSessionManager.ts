import { AudioPlaybackManager, type PlaybackState } from "./AudioPlaybackManager";

export class AudioSessionManager {
  private readonly playback = new AudioPlaybackManager();
  private activeTaskId: string | null = null;
  onStateChange(listener: (state: PlaybackState, taskId: string | null) => void): () => void {
    return this.playback.on((state) => listener(state, this.activeTaskId));
  }
  async play(taskId: string, source: string): Promise<void> { this.activeTaskId = taskId; await this.playback.play(source); }
  pause(): void { this.playback.pause(); }
  async resume(): Promise<void> { await this.playback.resume(); }
  stop(): void { this.playback.stop(); this.activeTaskId = null; }
  setVolume(value: number): void { this.playback.setVolume(value); }
  getCurrentTrack(): string | null { return this.playback.getCurrentTrack(); }
  getPlaybackState(): PlaybackState { return this.playback.getPlaybackState(); }
}
