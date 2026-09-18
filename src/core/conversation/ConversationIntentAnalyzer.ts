export type ConversationIntent = "command" | "question" | "casual" | "emotional_statement" | "frustration" | "uncertain";

export interface ConversationSignal {
  intent: ConversationIntent;
  confidence: number;
  urgency: "low" | "normal" | "high";
  cues: string[];
}

export type EmotionalSignal = "calm" | "positive" | "sad" | "frustrated" | "anxious" | "serious" | "uncertain";

export interface EmotionalResponsePolicy {
  signal: EmotionalSignal;
  confidence: number;
  intensity: "low" | "moderate" | "high";
  responseMode: "warm_supportive" | "calm_direct" | "analytical" | "neutral";
  humorAllowed: boolean;
  playfulAllowed: boolean;
  reason: string;
}

/** Deterministic, non-diagnostic social signal extraction before model reasoning. */
export class ConversationIntentAnalyzer {
  analyzeEmotion(text: string): EmotionalResponsePolicy {
    const value = text.trim().toLowerCase();
    if (!value) return { signal: "uncertain", confidence: 1, intensity: "low", responseMode: "neutral", humorAllowed: false, playfulAllowed: false, reason: "empty_input" };

    const highRisk = /\b(emergency|dangerous|unsafe|self[- ]harm|suicide|threat|abuse|hurt myself|can't breathe|panic attack)\b/i.test(value);
    const frustrated = /\b(frustrated|angry|annoyed|furious|stuck|broken|failed|failure|not working|hate this|useless)\b/i.test(value);
    const anxious = /\b(anxious|worried|overwhelmed|scared|afraid|nervous|stress(?:ed)?|panic|uncertain|don't know what to do)\b/i.test(value);
    const sad = /\b(sad|cry(?:ing)?|lonely|grief|hurt|heartbroken|upset|depressed|miss(?:ing)?)\b/i.test(value);
    const positive = /\b(happy|excited|amazing|awesome|wonderful|great news|proud|celebrat(?:e|ing)|thank(?:s| you))\b/i.test(value);

    if (highRisk) return { signal: "serious", confidence: 0.92, intensity: "high", responseMode: "calm_direct", humorAllowed: false, playfulAllowed: false, reason: "safety_or_emergency_language" };
    if (frustrated) return { signal: "frustrated", confidence: 0.86, intensity: "high", responseMode: "calm_direct", humorAllowed: false, playfulAllowed: false, reason: "frustration_or_failure_language" };
    if (anxious) return { signal: "anxious", confidence: 0.84, intensity: "moderate", responseMode: "warm_supportive", humorAllowed: false, playfulAllowed: false, reason: "worry_or_overwhelm_language" };
    if (sad) return { signal: "sad", confidence: 0.82, intensity: "moderate", responseMode: "warm_supportive", humorAllowed: false, playfulAllowed: false, reason: "sadness_or_loss_language" };
    if (positive) return { signal: "positive", confidence: 0.8, intensity: "moderate", responseMode: "warm_supportive", humorAllowed: true, playfulAllowed: true, reason: "positive_language" };

    return { signal: "calm", confidence: 0.55, intensity: "low", responseMode: "neutral", humorAllowed: true, playfulAllowed: false, reason: "no_strong_emotional_cue" };
  }

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
