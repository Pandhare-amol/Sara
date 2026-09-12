export type MusicWorkflowStage =
  | "IDEA" | "CONCEPT" | "LYRICS" | "COMPOSITION" | "MUSIC_GENERATION"
  | "VOCAL_GENERATION" | "MIX_MASTER" | "QUALITY_CHECK" | "ARTWORK"
  | "VIDEO" | "UPLOAD_PREPARATION" | "WAITING_USER" | "PUBLISHED";

export type MusicWorkflowStatus = "CREATED" | "QUEUED" | "RUNNING" | "WAITING_PROVIDER" | "VERIFYING" | "COMPLETED" | "RETRYING" | "FAILED" | "CANCELLED" | "WAITING_USER";

export interface CreativeBrief {
  theme: string;
  genre: string;
  mood: string;
  language: string;
  targetAudience: string;
  duration: "SHORT" | "MEDIUM" | "FULL";
  energyLevel: number;
  vocalStyle: string;
  referenceCharacteristics: string[];
}

export interface MusicWorkflowTask {
  taskId: string;
  projectId: string;
  conversationId?: string;
  stage: MusicWorkflowStage;
  status: MusicWorkflowStatus;
  progress: number;
  currentStep: string;
  retryCount: number;
  checkpoint: Record<string, unknown>;
  providerJobId?: string;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface MusicGenerationRequest {
  projectId: string;
  brief: CreativeBrief;
  lyrics: string;
  compositionPlan: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface MusicResult {
  provider: string;
  jobId: string;
  artifactPath?: string;
  mimeType?: string;
  durationSeconds?: number;
  verified: boolean;
}

export interface MusicProvider {
  readonly id: string;
  generateMusic(request: MusicGenerationRequest): Promise<MusicResult>;
  getStatus(jobId: string): Promise<{ status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; progress?: number; error?: string }>;
  cancel(jobId: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; details?: string }>;
}

export interface PublishingResult {
  platform: "youtube" | "instagram";
  videoId?: string;
  url?: string;
  verified: boolean;
}