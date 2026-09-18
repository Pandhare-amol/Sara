import fs from "fs";
import path from "path";
import { processConversationSlice, upsertMemory } from "../../server_memory";
import type { MemoryCategory } from "../lib/memoryTypes";

export interface OnlineLearningInteraction {
  conversationId?: string;
  userId?: string;
  source?: "desktop" | "mobile";
  userText: string;
  assistantText: string;
  history?: Array<{ role: string; text: string }>;
  apiKey?: string;
}

export interface OnlineLearningStatus {
  enabled: boolean;
  interactionsObserved: number;
  episodesRecorded: number;
  explicitMemoriesLearned: number;
  semanticPassesCompleted: number;
  skippedByUser: number;
  failures: number;
  feedbackReceived: number;
  correctionsLearned: number;
  lastLearnedAt: string | null;
}

export interface OnlineLearningFeedback {
  conversationId?: string;
  source?: "desktop" | "mobile";
  feedback: string;
  correctedAnswer?: string;
}

type ExplicitMemory = {
  category: MemoryCategory;
  text: string;
  semanticType: "preference" | "fact" | "goal" | "project" | "identity";
};

const STATE_FILE = path.resolve(process.cwd(), "data", "online-learning-state.json");
const MAX_MEMORY_TEXT = 300;
const NO_STORE_PATTERN = /\b(?:don't|do not|never)\s+(?:remember|store|save|keep)\b/i;

function readStatus(): OnlineLearningStatus {
  const defaults: OnlineLearningStatus = {
    enabled: true,
    interactionsObserved: 0,
    episodesRecorded: 0,
    explicitMemoriesLearned: 0,
    semanticPassesCompleted: 0,
    skippedByUser: 0,
    failures: 0,
    feedbackReceived: 0,
    correctionsLearned: 0,
    lastLearnedAt: null,
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
    }
  } catch {
    // Learning telemetry must never prevent normal conversation.
  }
  return defaults;
}

function persistStatus(status: OnlineLearningStatus): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2), "utf8");
    fs.renameSync(temporary, STATE_FILE);
  } catch {
    // Learning telemetry is best effort; the memory stores remain authoritative.
  }
}

function normalizeExplicitText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_TEXT);
}

export function extractExplicitMemory(text: string): ExplicitMemory | null {
  const normalized = normalizeExplicitText(text);
  if (!normalized || NO_STORE_PATTERN.test(normalized)) return null;

  const rules: Array<{ pattern: RegExp; category: MemoryCategory; semanticType: ExplicitMemory["semanticType"] }> = [
    { pattern: /^(?:please\s+)?(?:remember|don't forget)\s+(?:that\s+)?(.+)$/i, category: "identity", semanticType: "fact" },
    { pattern: /^(?:my name is|call me)\s+(.+)$/i, category: "identity", semanticType: "identity" },
    { pattern: /^(?:i prefer|i like|i love|i usually prefer)\s+(.+)$/i, category: "preference", semanticType: "preference" },
    { pattern: /^(?:i dislike|i hate|i do not like|i don't like)\s+(.+)$/i, category: "preference", semanticType: "preference" },
    { pattern: /^(?:my goal is|i want to|i plan to)\s+(.+)$/i, category: "goal", semanticType: "goal" },
    { pattern: /^(?:i am working on|i'm working on|this project is)\s+(.+)$/i, category: "project", semanticType: "project" },
    { pattern: /^(?:i work at|i work for|i am a|i'm a)\s+(.+)$/i, category: "identity", semanticType: "fact" },
  ];

  for (const rule of rules) {
    const match = normalized.match(rule.pattern);
    if (match?.[1]) {
      const content = normalizeExplicitText(match[1]);
      if (content.length >= 2) {
        const storedText = rule.category === "preference"
          ? `User preference: ${content}`
          : rule.category === "goal"
            ? `User goal: ${content}`
            : rule.category === "project"
              ? `User project: ${content}`
              : normalized.startsWith("my name") || normalized.startsWith("call me")
                ? `User's name is ${content}`
                : normalized.startsWith("i ") || normalized.startsWith("i'")
                  ? `User ${normalized.slice(2)}`
                  : content;
        return {
          category: rule.category,
          semanticType: rule.semanticType,
          text: storedText,
        };
      }
    }
  }
  return null;
}

export function classifyFeedback(feedback: string): "positive" | "negative" | "neutral" {
  if (/\b(?:wrong|incorrect|not right|that is false|you are mistaken|bad answer|try again|fix that)\b/i.test(feedback)) return "negative";
  if (/\b(?:correct|right|perfect|helpful|worked|well done|thank you|thanks)\b/i.test(feedback)) return "positive";
  return "neutral";
}

export class OnlineLearningService {
  private status = readStatus();
  private queue: Promise<void> = Promise.resolve();

  observeInteraction(interaction: OnlineLearningInteraction): void {
    this.queue = this.queue
      .then(() => this.learn(interaction))
      .catch(() => {
        this.status.failures++;
        persistStatus(this.status);
      });
  }

  recordFeedback(feedback: OnlineLearningFeedback): void {
    this.queue = this.queue
      .then(() => this.learnFeedback(feedback))
      .catch(() => {
        this.status.failures++;
        persistStatus(this.status);
      });
  }

  getStatus(): OnlineLearningStatus {
    return { ...this.status };
  }

  private async learn(interaction: OnlineLearningInteraction): Promise<void> {
    this.status.interactionsObserved++;
    const source = interaction.source === "mobile" ? "mobile" : "desktop";
    const conversationId = interaction.conversationId || `conversation-${Date.now()}`;

    if (NO_STORE_PATTERN.test(interaction.userText)) {
      this.status.skippedByUser++;
      this.status.lastLearnedAt = new Date().toISOString();
      persistStatus(this.status);
      return;
    }

    const { getCognitiveOrchestrator } = await import("../cognitive");
    const orchestrator = getCognitiveOrchestrator();
    orchestrator.recordEpisode({
      conversationId,
      title: `Conversation interaction: ${interaction.userText.slice(0, 80)}`,
      context: {
        goal: interaction.userText,
        environment: source,
        initialState: { userId: interaction.userId || "default-user" },
      },
      plan: { steps: [] },
      execution: {
        actions: [],
        observations: [{
          id: `observation-${Date.now()}`,
          timestamp: Date.now(),
          type: "event",
          content: { userText: interaction.userText, assistantText: interaction.assistantText },
          metadata: { source },
        }],
      },
      outcome: {
        success: true,
        goalAchieved: true,
        completionTime: 0,
        userIntervention: false,
      },
      lesson: { keyInsights: ["Conversation context observed for future retrieval."] },
      metadata: { importance: 3, confidence: 0.55, tags: ["online-learning", "conversation"] },
    });
    this.status.episodesRecorded++;

    const explicit = extractExplicitMemory(interaction.userText);
    if (explicit) {
      await upsertMemory({
        id: "",
        category: explicit.category,
        text: explicit.text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: explicit.category === "goal" ? 7 : 6,
        confidence: 0.85,
        source: "user_provided",
        verificationStatus: "unverified",
        tier: "semantic",
        storageSource: source,
        keywords: [],
      }, source);
      this.status.explicitMemoriesLearned++;
    }

    const dialogue = [...(interaction.history || []), { role: "user", text: interaction.userText }, { role: "assistant", text: interaction.assistantText }];
    if (interaction.apiKey && dialogue.length >= 2) {
      const learned = await processConversationSlice(interaction.apiKey, dialogue, source);
      if (learned) this.status.semanticPassesCompleted++;
    }

    this.status.lastLearnedAt = new Date().toISOString();
    persistStatus(this.status);
  }

  private async learnFeedback(feedback: OnlineLearningFeedback): Promise<void> {
    const kind = classifyFeedback(feedback.feedback);
    this.status.feedbackReceived++;
    const source = feedback.source === "mobile" ? "mobile" : "desktop";
    const correction = feedback.correctedAnswer?.trim();
    const content = correction
      ? `Correction from user: ${correction}`
      : `User feedback: ${feedback.feedback.trim().slice(0, MAX_MEMORY_TEXT)}`;

    const { getCognitiveOrchestrator } = await import("../cognitive");
    getCognitiveOrchestrator().recordEpisode({
      conversationId: feedback.conversationId,
      title: `User feedback: ${feedback.feedback.slice(0, 80)}`,
      context: { goal: "Improve future responses", environment: source, initialState: {} },
      plan: { steps: [] },
      execution: {
        actions: [],
        observations: [{
          id: `feedback-${Date.now()}`,
          timestamp: Date.now(),
          type: "event",
          content: { feedback: feedback.feedback, correctedAnswer: correction || null },
          metadata: { source, kind },
        }],
        corrections: correction ? [{
          id: `correction-${Date.now()}`,
          timestamp: Date.now(),
          originalAction: "assistant-response",
          correctionType: "user_feedback",
          reason: feedback.feedback,
          newAction: correction,
        }] : undefined,
      },
      outcome: { success: kind !== "negative", goalAchieved: kind !== "negative", completionTime: 0, userIntervention: true },
      lesson: { keyInsights: [content] },
      metadata: { importance: kind === "negative" ? 7 : 5, confidence: 0.8, tags: ["online-learning", "feedback", kind] },
    });

    if (correction) {
      await upsertMemory({
        id: "",
        category: "behavior",
        text: content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 7,
        confidence: 0.8,
        source: "user_provided",
        verificationStatus: "unverified",
        tier: "semantic",
        storageSource: source,
        keywords: [],
      }, source);
      this.status.correctionsLearned++;
    }
    this.status.lastLearnedAt = new Date().toISOString();
    persistStatus(this.status);
  }
}

let onlineLearningService: OnlineLearningService | null = null;

export function getOnlineLearningService(): OnlineLearningService {
  if (!onlineLearningService) onlineLearningService = new OnlineLearningService();
  return onlineLearningService;
}

export function resetOnlineLearningServiceForTests(): void {
  onlineLearningService = null;
}