export type ConversationIntent = "command" | "question" | "casual" | "emotional_statement" | "frustration" | "uncertain";

export interface ConversationSignal {
  intent: ConversationIntent;
  confidence: number;
  urgency: "low" | "normal" | "high";
  cues: string[];
}

/** Deterministic, non-diagnostic social signal extraction before model reasoning. */
export class ConversationIntentAnalyzer {
  analyze(text: string): ConversationSignal {
    const value = text.trim();
    const lower = value.toLowerCase();
    if (!value) return { intent: "uncertain", confidence: 1, urgency: "low", cues: ["empty_input"] };

    const cues: string[] = [];
    const urgent = /\b(urgent(?:ly)?|asap|immediately|emergency|right now)\b/i.test(value);
    if (urgent) cues.push("urgency_language");
    if (/\b(i am|i'm|im)\s+(so\s+)?(tired|exhausted|stressed|sad|happy|frustrated|angry|overwhelmed)\b/i.test(value)) {
      cues.push("emotion_language");
      return { intent: "emotional_statement", confidence: 0.9, urgency: urgent ? "high" : "normal", cues };
    }
    if (/(this is|it is|that's|that is)\s+(broken|not working|wrong)|\b(failed|failure|error|doesn't work|not working)\b/i.test(value)) {
      cues.push("failure_language");
      return { intent: "frustration", confidence: 0.82, urgency: urgent ? "high" : "normal", cues };
    }
    if (/^(please\s+)?(open|close|start|launch|find|search|send|make|create|type|click|press|show|run|delete|move|copy|play)\b/i.test(value)) {
      cues.push("imperative");
      return { intent: "command", confidence: 0.9, urgency: urgent ? "high" : "normal", cues };
    }
    if (/[?]\s*$/.test(value) || /^(what|why|how|when|where|who|can|could|would|do|is|are)\b/i.test(lower)) {
      cues.push("question_form");
      return { intent: "question", confidence: 0.88, urgency: urgent ? "high" : "normal", cues };
    }
    if (/\b(hello|hi|hey|thanks|thank you|good morning|good night|what do you think)\b/i.test(value)) {
      cues.push("social_language");
      return { intent: "casual", confidence: 0.78, urgency: urgent ? "high" : "low", cues };
    }
    return { intent: "uncertain", confidence: 0.55, urgency: urgent ? "high" : "normal", cues };
  }
}

export const conversationIntentAnalyzer = new ConversationIntentAnalyzer();
