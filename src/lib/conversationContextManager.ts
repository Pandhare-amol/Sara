export type ConversationContextMessage = {
  id?: string;
  conversationId?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
};

export type ConversationContextSnapshot = {
  id: string;
  title: string;
  summary: string;
  topic: string;
  activeTask: string;
  pendingAction: string;
  recentTopics: string[];
  workingContext: ConversationContextMessage[];
  memoryHints: string[];
  contextWindowLimit: number;
  tokenBudget: number;
};

export function createConversationContextSnapshot(input: Partial<ConversationContextSnapshot> & { summary?: string; topic?: string; activeTask?: string; pendingAction?: string; recentTopics?: string[]; workingContext?: ConversationContextMessage[]; }): ConversationContextSnapshot {
  return {
    id: input.id || "conversation-context",
    title: input.title || "SARA Conversation",
    summary: input.summary || "Continue the previous conversation context.",
    topic: input.topic || "general",
    activeTask: input.activeTask || "Continue the current task",
    pendingAction: input.pendingAction || "Review the most relevant context",
    recentTopics: input.recentTopics || [],
    workingContext: input.workingContext || [],
    memoryHints: input.memoryHints || [],
    contextWindowLimit: input.contextWindowLimit || 12000,
    tokenBudget: input.tokenBudget || 8000,
  };
}

export class ConversationContextManager {
  private readonly maxWorkingMessages: number;
  private readonly tokenBudget: number;

  constructor(options?: { maxWorkingMessages?: number; tokenBudget?: number }) {
    this.maxWorkingMessages = Math.max(2, options?.maxWorkingMessages ?? 8);
    this.tokenBudget = Math.max(1024, options?.tokenBudget ?? 8192);
  }

  private detectTopic(messages: ConversationContextMessage[]): string {
    const recentMessages = messages.slice(-12);
    const topics = [
      { key: "project planning", regex: /(project|milestone|roadmap|deliverable|planning|timeline)/i },
      { key: "python", regex: /(python|pandas|numpy|functions|class|debugging)/i },
      { key: "physics", regex: /(physics|equation|chapter|force|motion|energy|momentum)/i },
      { key: "research", regex: /(research|paper|summary|article|citation|source)/i },
      { key: "coding", regex: /(code|build|fix|deploy|debug|test|refactor)/i },
    ];

    let leadingTopic = "general";
    let leadingScore = -1;

    for (const topic of topics) {
      const score = recentMessages.reduce((count, message) => count + (topic.regex.test(message.content) ? 1 : 0), 0);
      if (score > leadingScore) {
        leadingTopic = topic.key;
        leadingScore = score;
      }
    }

    return leadingScore > 0 ? leadingTopic : "general";
  }

  private summarizeHistory(messages: ConversationContextMessage[]): string {
    const sentence = messages
      .slice(-8)
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join(" ");
    return sentence.length > 220 ? `${sentence.slice(0, 220)}…` : sentence || "Continue the previous conversation context.";
  }

  buildContextSnapshot(record: { id?: string; title?: string; messages: ConversationContextMessage[] }): ConversationContextSnapshot {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const workingContext = messages.slice(-this.maxWorkingMessages);
    const topic = this.detectTopic(messages);
    const recentTopics = Array.from(
      new Set(
        messages
          .slice(-12)
          .map((message) => this.detectTopic([message]))
          .filter((value) => value !== "general")
      )
    );
    const summary = this.summarizeHistory(messages);

    return createConversationContextSnapshot({
      id: record.id || "conversation-context",
      title: record.title || "SARA Conversation",
      summary,
      topic,
      activeTask: topic === "python" ? "Continue the Python task" : topic === "physics" ? "Review the physics chapter" : "Continue the current task",
      pendingAction: topic === "project planning" ? "Review milestones and next steps" : "Keep the relevant topic in focus",
      recentTopics: recentTopics.length > 0 ? recentTopics : [topic],
      workingContext,
      contextWindowLimit: this.tokenBudget,
      tokenBudget: this.tokenBudget,
    });
  }
}
