export interface ContextMessage {
  role: string;
  content: string;
  timestamp?: string;
}

export interface ContextMemory {
  text: string;
  category?: string;
  importance?: number;
}

export interface ContextTask {
  taskId?: string;
  description?: string;
  status?: string;
  checkpoint?: Record<string, unknown> | null;
}

export interface ContextUserProfile {
  userId: string;
  displayName: string;
  relationship?: string;
  preferences?: Record<string, unknown>;
  communicationStyle?: Record<string, unknown>;
  importantContext?: Record<string, unknown>;
}

export interface ContextConversationSignal {
  intent: string;
  confidence: number;
  urgency: string;
  cues: string[];
}

export interface ContextDigitalWorld {
  observedAt: string;
  activeApplication?: string;
  activeWindow?: string;
  activeProject?: string;
  applications: unknown[];
  browserTabs: unknown[];
  unfinishedWork: string[];
  attentionItems: unknown[];
}

export interface ContextInput {
  userInput: string;
  recentMessages?: ContextMessage[];
  relevantMemories?: ContextMemory[];
  activeTasks?: ContextTask[];
  summary?: string;
  userProfile?: ContextUserProfile;
  conversationSignal?: ContextConversationSignal;
  digitalWorld?: ContextDigitalWorld;
  maxCharacters?: number;
}

export interface BuiltContext {
  text: string;
  characters: number;
  included: { currentInput: boolean; activeTasks: number; recentMessages: number; memories: number; summary: boolean; userProfile: boolean; conversationSignal: boolean; digitalWorld: boolean };
}

/** Builds a bounded context window without replacing persistent memory ownership. */
export class ContextManager {
  public build(input: ContextInput): BuiltContext {
    const maxCharacters = Math.max(1000, input.maxCharacters ?? 12_000);
    const sections: string[] = [];
    const included = { currentInput: false, activeTasks: 0, recentMessages: 0, memories: 0, summary: false, userProfile: false, conversationSignal: false, digitalWorld: false };

    this.append(sections, `CURRENT USER REQUEST:\n${input.userInput.trim()}`, maxCharacters, included, "currentInput");

    if (input.userProfile) {
      const profile = input.userProfile;
      this.append(sections, `USER PROFILE: ${JSON.stringify({
        userId: profile.userId,
        displayName: profile.displayName,
        relationship: profile.relationship,
        preferences: profile.preferences || {},
        communicationStyle: profile.communicationStyle || {},
        importantContext: profile.importantContext || {},
      })}`, maxCharacters, included, "userProfile");
      included.userProfile = sections.some((section) => section.startsWith("USER PROFILE:"));
    }

    if (input.conversationSignal) {
      const signal = input.conversationSignal;
      included.conversationSignal = this.append(sections, `CONVERSATION SIGNAL: ${JSON.stringify(signal)}. Treat this as a tentative local cue, not a diagnosis or fact.`, maxCharacters, included, "conversationSignal");
    }

    for (const task of input.activeTasks || []) {
      const checkpoint = task.checkpoint ? ` checkpoint=${JSON.stringify(task.checkpoint)}` : "";
      if (this.append(sections, `ACTIVE TASK: ${task.taskId || "unknown"} | ${task.status || "unknown"} | ${task.description || ""}${checkpoint}`, maxCharacters, included, "activeTasks")) included.activeTasks += 1;
    }

    if (input.digitalWorld) {
      included.digitalWorld = this.append(
        sections,
        `DIGITAL WORLD (observed ${input.digitalWorld.observedAt}): ${JSON.stringify({
          activeApplication: input.digitalWorld.activeApplication,
          activeWindow: input.digitalWorld.activeWindow,
          activeProject: input.digitalWorld.activeProject,
          applications: input.digitalWorld.applications,
          browserTabs: input.digitalWorld.browserTabs,
          unfinishedWork: input.digitalWorld.unfinishedWork,
          attentionItems: input.digitalWorld.attentionItems,
        })}`,
        maxCharacters,
        included,
        "digitalWorld",
      );
    }

    if (input.summary?.trim() && this.append(sections, `CONVERSATION SUMMARY:\n${input.summary.trim()}`, maxCharacters, included, "summary")) included.summary = true;

    for (const message of (input.recentMessages || []).slice(-20)) {
      if (this.append(sections, `RECENT ${message.role.toUpperCase()}: ${message.content}`, maxCharacters, included, "recentMessages")) included.recentMessages += 1;
    }

    for (const memory of (input.relevantMemories || []).slice(0, 12)) {
      if (this.append(sections, `RELEVANT MEMORY [${memory.category || "general"}]: ${memory.text}`, maxCharacters, included, "memories")) included.memories += 1;
    }

    const text = sections.join("\n\n");
    return { text, characters: text.length, included };
  }

  private append(sections: string[], value: string, maxCharacters: number, included: BuiltContext["included"], kind: keyof BuiltContext["included"]): boolean {
    if (!value.trim()) return false;
    const separatorLength = sections.length ? 2 : 0;
    if (sections.join("\n\n").length + separatorLength + value.length > maxCharacters) return false;
    sections.push(value);
    if (kind === "currentInput") included.currentInput = true;
    return true;
  }
}

export const contextManager = new ContextManager();
