import type { EmotionalSignal } from "./advanced-types";

export class EmotionalIntelligenceService {
  detect(text: string): EmotionalSignal {
    const lower = text.toLowerCase();
    const rules: Array<[EmotionalSignal["emotion"], RegExp, EmotionalSignal["tone"]]> = [["anger", /\b(angry|furious|hate|annoyed)\b/, "calm"], ["sadness", /\b(sad|hurt|lonely|disappointed)\b/, "supportive"], ["fear", /\b(afraid|worried|scared|risk)\b/, "calm"], ["joy", /\b(happy|great|love|excited)\b/, "warm"], ["surprise", /\b(wow|unexpected|surprised)\b/, "direct"]];
    const match = rules.find(([, pattern]) => pattern.test(lower));
    return { emotion: match?.[0] ?? "neutral", intensity: match ? 0.7 : 0, tone: match?.[2] ?? "direct", evidence: match ? [`Matched emotional language for ${match[0]}.`] : [] };
  }
  adapt(text: string, signal: EmotionalSignal): string { return signal.tone === "supportive" ? `I hear that this is difficult. ${text}` : signal.tone === "calm" ? `Let's work through this carefully. ${text}` : text; }
}
