import { contextManager } from "./ContextManager";
import { recentChatHistory } from "./recentChatHistory";

/** Compact, same-conversation text/voice context for a *new* Live connection.
 * The persisted transcript is retained untouched. Metadata is a hint, never
 * authorization or proof of a completed desktop task.
 */
export function buildVoiceResumeContext(input: {
  messages: Array<{ role: string; content?: string; text?: string }>;
  summary?: string;
  objective?: string;
  userProfile?: { userId: string; displayName: string; relationship?: string; preferences?: Record<string, unknown> };
}): string {
  const recent = recentChatHistory(input.messages.map((message) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : message.text,
  })));
  const summary = String(input.summary || "").trim().slice(0, 300);
  const objective = String(input.objective || "").trim().slice(0, 160);
  return contextManager.build({
    userInput: "",
    includeUserInput: false,
    recentMessages: recent.map((turn) => ({ role: turn.role, content: turn.text })),
    summary: summary || objective || undefined,
    userProfile: input.userProfile,
    maxCharacters: 10_000,
  }).text;
}
