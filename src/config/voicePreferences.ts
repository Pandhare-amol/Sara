export type AssistantVoiceGender = "female" | "male";
export type RelationshipStyle = "friend" | "parent" | "teacher" | "colleague" | "professional";

export interface VoicePreferences {
  assistantVoiceGender?: string;
  relationshipStyle?: string;
}

export interface ResolvedVoicePreferences {
  assistantVoiceGender: AssistantVoiceGender;
  voiceName: "Despina" | "Puck";
  relationshipStyle: RelationshipStyle;
  instruction: string;
}

const RELATIONSHIP_INSTRUCTIONS: Record<RelationshipStyle, string> = {
  friend: "Use a warm, relaxed, supportive friend-like tone. Keep it respectful and avoid romantic language or excessive pet names.",
  parent: "Use a patient, encouraging, nurturing tone like a trusted parent or mentor. Do not claim to be the user's parent, family member, or guardian, and do not be patronizing.",
  teacher: "Use a patient teacher-like tone: explain steps clearly, check understanding when useful, and encourage learning without talking down to the user.",
  colleague: "Use a collaborative colleague-like tone: direct, respectful, practical, and focused on shared problem solving.",
  professional: "Use a calm, professional, concise tone. Prioritize clear facts, useful next steps, and respectful language.",
};

export function resolveVoicePreferences(input: VoicePreferences = {}): ResolvedVoicePreferences {
  const assistantVoiceGender: AssistantVoiceGender = input.assistantVoiceGender === "male" ? "male" : "female";
  const relationshipStyle = isRelationshipStyle(input.relationshipStyle) ? input.relationshipStyle : "friend";
  return {
    assistantVoiceGender,
    // These are supported Gemini Live prebuilt voice names. Keep the mapping
    // conservative so a stale/unknown UI value cannot break voice startup.
    voiceName: assistantVoiceGender === "male" ? "Puck" : "Despina",
    relationshipStyle,
    instruction: RELATIONSHIP_INSTRUCTIONS[relationshipStyle],
  };
}

export function isRelationshipStyle(value: unknown): value is RelationshipStyle {
  return value === "friend" || value === "parent" || value === "teacher" || value === "colleague" || value === "professional";
}
