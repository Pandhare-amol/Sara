export type SingerIntent =
  | "SING_ORIGINAL"
  | "SING_USER_LYRICS"
  | "SING_PUBLIC_DOMAIN"
  | "GENERATE_SONG"
  | "PLAY_EXISTING_AUDIO"
  | "STOP_SINGING"
  | "PAUSE_SINGING"
  | "RESUME_SINGING"
  | "CHANGE_STYLE"
  | "CHANGE_MOOD"
  | "NONE";

export type SingerTaskStatus =
  | "QUEUED" | "ANALYZING" | "WRITING_LYRICS" | "PREPARING_MUSIC"
  | "GENERATING_VOCALS" | "MIXING" | "READY" | "PLAYING" | "PAUSED"
  | "COMPLETED" | "FAILED" | "PARTIAL_FAILURE" | "CANCELLED";

export type SingerMood = "HAPPY" | "CALM" | "ROMANTIC" | "SAD" | "MOTIVATIONAL" | "ENERGETIC" | "RELAXING" | "EMOTIONAL" | "DEVOTIONAL" | "CINEMATIC";
export type SingerStyle = "POP" | "SOFT_ACOUSTIC" | "LOFI" | "CLASSICAL_INSPIRED" | "ELECTRONIC" | "ROCK" | "AMBIENT" | "PIANO" | "ORCHESTRAL" | "INDIAN_FUSION";
export type SongDuration = "SHORT" | "MEDIUM" | "FULL";
export type SupportedSingerLanguage = "en" | "hi" | "mr";

export interface SingerIntentResult {
  intent: SingerIntent;
  confidence: number;
  language: SupportedSingerLanguage;
  mood?: SingerMood;
  style?: SingerStyle;
  duration: SongDuration;
  userLyrics?: string;
  request: string;
}

export interface SongPlan {
  language: SupportedSingerLanguage;
  mood: SingerMood;
  style: SingerStyle;
  duration: SongDuration;
  tempoBpm: number;
  energy: number;
  vocalStyle: string;
  instrumentalProfile: string;
  sections: string[];
}

export interface LyricsDocument {
  source: "ORIGINAL" | "USER_PROVIDED" | "PUBLIC_DOMAIN";
  language: SupportedSingerLanguage;
  text: string;
  sections: Array<{ name: string; text: string }>;
}

export interface AudioResult {
  audioPath: string;
  mimeType: string;
  durationSeconds: number;
  provider: string;
  verified: boolean;
}

export interface SingingProvider {
  readonly id: string;
  generateVocals(request: { lyrics: LyricsDocument; plan: SongPlan; persona: VocalPersona; signal?: AbortSignal }): Promise<AudioResult>;
  generateInstrumental(request: { plan: SongPlan; signal?: AbortSignal }): Promise<AudioResult>;
  cancel?(providerTaskId: string): Promise<void>;
}

export interface VocalPersona {
  id: string;
  gender: "female";
  baseCharacteristics: string[];
  singingCharacteristics: string[];
  originalityStatement: string;
}

export interface SingerSessionContext {
  sessionId: string;
  songId?: string;
  taskId: string;
  conversationId: string;
  lyrics?: LyricsDocument;
  language?: SupportedSingerLanguage;
  mood?: SingerMood;
  style?: SingerStyle;
  tempo?: number;
  vocalProfile: VocalPersona;
  instrumentalProfile?: string;
  audioPath?: string;
  audioMimeType?: string;
  createdAt: string;
}

export interface SingerTask {
  taskId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  status: SingerTaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string; retryable?: boolean };
  session: SingerSessionContext;
}

export const SARA_VOCAL_PERSONA: VocalPersona = {
  id: "sara-original-synthetic-v1",
  gender: "female",
  baseCharacteristics: ["warm", "soft", "expressive", "natural", "emotionally responsive", "clear pronunciation", "gentle tone"],
  singingCharacteristics: ["melodic", "controlled breathing simulation", "emotional phrasing", "dynamic volume", "natural pauses", "rhythm awareness", "smooth transitions"],
  originalityStatement: "An original synthetic SARA vocal identity; it does not imitate or clone a real person.",
};
