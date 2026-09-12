import type { SingerIntentResult, SingerTask, SingingProvider, LyricsDocument } from "./SingerTypes";
import { lyricsManager } from "./LyricsManager";
import { musicStyleEngine } from "./MusicStyleEngine";
import { songIntentAnalyzer } from "./SongIntentAnalyzer";
import { AudioCacheManager } from "./AudioCacheManager";
import { AudioMixer } from "./AudioMixer";
import { SingerProviderError, createSingingProvider } from "./SingerProviders";
import { SingerSessionStore } from "./SingerSession";

export type SingerEvent = { type: "singer:task"; task: SingerTask };
export type LyricsGenerator = (request: string, language: string, sections: string[]) => Promise<string>;

export class SingerAgent {
  private readonly listeners = new Set<(event: SingerEvent) => void>();
  private readonly abortControllers = new Map<string, AbortController>();
  constructor(private readonly provider: SingingProvider = createSingingProvider(), private readonly sessions = new SingerSessionStore(), private readonly cache = new AudioCacheManager(), private readonly generateLyrics?: LyricsGenerator, private readonly mixer = new AudioMixer()) {}
  on(listener: (event: SingerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  analyze(request: string): SingerIntentResult { return songIntentAnalyzer.analyze(request); }
  submit(input: { request: string; userId?: string; conversationId: string; correlationId?: string; lyrics?: string }): SingerTask {
    const task = this.sessions.createTask({ userId: input.userId || "default-user", conversationId: input.conversationId, correlationId: input.correlationId });
    const controller = new AbortController(); this.abortControllers.set(task.taskId, controller);
    void this.run(task.taskId, input, controller).catch((error) => this.fail(task.taskId, error));
    return task;
  }
  cancel(taskId: string): SingerTask | undefined { this.abortControllers.get(taskId)?.abort(); this.abortControllers.delete(taskId); return this.emitUpdate(this.sessions.update(taskId, "CANCELLED", this.sessions.get(taskId)?.progress || 0)); }
  getTask(taskId: string): SingerTask | undefined { return this.sessions.get(taskId); }
  getCurrent(conversationId: string): SingerTask | undefined { return this.sessions.getByConversation(conversationId); }
  private async run(taskId: string, input: { request: string; lyrics?: string }, controller: AbortController): Promise<void> {
    const intent = this.update(taskId, "ANALYZING", 10); if (!intent) return;
    const analyzed = songIntentAnalyzer.analyze(input.request);
    if (["NONE", "PLAY_EXISTING_AUDIO", "STOP_SINGING", "PAUSE_SINGING", "RESUME_SINGING", "CHANGE_STYLE", "CHANGE_MOOD"].includes(analyzed.intent)) throw new SingerProviderError("SINGER_INTENT_NOT_GENERATION", "This command controls or discusses singing; it is not a generation request.");
    const plan = musicStyleEngine.createPlan({ language: analyzed.language, mood: analyzed.mood, style: analyzed.style, duration: analyzed.duration });
    let lyrics: LyricsDocument;
    if (input.lyrics || analyzed.userLyrics) lyrics = lyricsManager.validateUserLyrics(input.lyrics || analyzed.userLyrics || "", plan.language);
    else {
      this.update(taskId, "WRITING_LYRICS", 25);
      if (!this.generateLyrics) throw new SingerProviderError("LYRICS_GENERATOR_UNAVAILABLE", "SARA has no configured lyrics generation service for original songs.");
      lyrics = lyricsManager.fromGeneratedText(await this.generateLyrics(analyzed.request, plan.language, plan.sections), plan);
    }
    this.sessions.updateSession(taskId, { lyrics, language: plan.language, mood: plan.mood, style: plan.style, tempo: plan.tempoBpm, instrumentalProfile: plan.instrumentalProfile });
    this.update(taskId, "PREPARING_MUSIC", 40);
    const vocals = await this.withRetry(() => this.provider.generateVocals({ lyrics, plan, persona: this.sessions.get(taskId)!.session.vocalProfile, signal: controller.signal }), controller);
    this.update(taskId, "GENERATING_VOCALS", 60);
    const instrumental = await this.withRetry(() => this.provider.generateInstrumental({ plan, signal: controller.signal }), controller);
    this.update(taskId, "MIXING", 80);
    if (!vocals.verified || !instrumental.verified) throw new SingerProviderError("AUDIO_VERIFICATION_FAILED", "The singing provider returned an unverified audio artifact.");
    const mixed = await this.mixer.mix(vocals, instrumental, this.cache.getDirectory());
    this.sessions.updateSession(taskId, { audioPath: mixed.audioPath, audioMimeType: mixed.mimeType });
    await this.cache.enforceLimit();
    this.update(taskId, "READY", 100);
  }
  private async withRetry<T>(operation: () => Promise<T>, controller: AbortController): Promise<T> { let last: unknown; for (let attempt = 1; attempt <= 3; attempt++) { if (controller.signal.aborted) throw new SingerProviderError("SINGER_CANCELLED", "Singing generation was cancelled."); try { return await operation(); } catch (error) { last = error; if (!(error instanceof SingerProviderError) || !error.retryable || attempt === 3) throw error; await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1))); } } throw last; }
  private update(taskId: string, status: SingerTask["status"], progress: number): SingerTask | undefined { return this.emitUpdate(this.sessions.update(taskId, status, progress)); }
  private emitUpdate(task: SingerTask | undefined): SingerTask | undefined { if (task) this.listeners.forEach((listener) => listener({ type: "singer:task", task })); return task; }
  private fail(taskId: string, error: unknown): void { const message = error instanceof Error ? error.message : "Singer generation failed."; const code = error instanceof SingerProviderError ? error.code : "SINGER_GENERATION_FAILED"; this.emitUpdate(this.sessions.update(taskId, "FAILED", this.sessions.get(taskId)?.progress || 0, { code, message, retryable: error instanceof SingerProviderError && error.retryable })); this.abortControllers.delete(taskId); }
}
