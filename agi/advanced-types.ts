export type Modality = "image" | "document" | "audio" | "video" | "code";
export type MemoryKind = "episodic" | "semantic" | "procedural" | "working" | "associative";
export type AgentKind = "research" | "analysis" | "reporting" | "monitoring" | "optimization";

export interface MediaInput { modality: Modality; data: string | Uint8Array; mimeType?: string; name?: string; metadata?: Record<string, unknown>; }
export interface MediaAdapter { readonly modality: Modality; understand(input: MediaInput, instruction?: string): Promise<string>; generate?(prompt: string, options?: Record<string, unknown>): Promise<MediaInput>; }
export interface CodeAdapter extends MediaAdapter { readonly modality: "code"; explain(code: string, language?: string): Promise<string>; generateCode(specification: string, language: string): Promise<string>; }

export interface AgentTask { id: string; kind: AgentKind; objective: string; input?: unknown; sessionId: string; userId?: string; budgetMs?: number; }
export interface AgentResult { taskId: string; kind: AgentKind; output: unknown; confidence: number; evidence: string[]; completedAt: number; }
export interface AgentRuntime { run(task: AgentTask): Promise<AgentResult>; }

export interface CollaborationMessage { from: string; to?: string; taskId: string; content: string; confidence: number; timestamp: number; }
export interface ConsensusResult { decision: string; confidence: number; votes: Array<{ agentId: string; decision: string; confidence: number }>; conflicts: string[]; }

export interface FeedbackEvent { userId?: string; sessionId: string; feature: string; responseId?: string; rating?: -1 | 1; implicitSignal?: "follow_up" | "accepted" | "ignored" | "completed"; timestamp: number; metadata?: Record<string, unknown>; }
export interface LearningRecord { id: string; input: string; output: string; label?: string; score?: number; createdAt: number; }

export interface Explanation { summary: string; confidence: number; evidence: string[]; alternatives: string[]; reasoningTrace: string[]; }
export interface SafetyResult { allowed: boolean; text: string; categories: string[]; redactions: Array<{ type: string; replacement: string }>; warnings: string[]; }
export interface ReasoningStep { title: string; conclusion: string; confidence: number; evidence: string[]; }
export interface ReasoningResult { answer: string; steps: ReasoningStep[]; assumptions: string[]; counterfactuals: string[]; }
export interface EmotionalSignal { emotion: "joy" | "sadness" | "anger" | "fear" | "surprise" | "neutral"; intensity: number; tone: "warm" | "direct" | "calm" | "supportive"; evidence: string[]; }
