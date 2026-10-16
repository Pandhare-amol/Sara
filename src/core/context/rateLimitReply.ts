/** Provider fallback: never turn client-provided task metadata into an outcome claim. */
export function buildRateLimitFallbackResponse(
  _userText: string,
  conversationContext?: { summary?: string; activeContext?: Record<string, unknown>; taskState?: Record<string, unknown> },
): string {
  const summary = String(conversationContext?.summary || "").trim();
  const objective = conversationContext?.activeContext && typeof conversationContext.activeContext.objective === "string"
    ? conversationContext.activeContext.objective.trim().slice(0, 120)
    : summary.slice(0, 120) || "our conversation";
  return `I’m temporarily rate-limited by the AI provider, so I have not completed this answer. Your conversation about ${objective} is saved; please retry when the provider is available. I cannot confirm a desktop task’s outcome from chat metadata—check its actual task status before assuming it is finished.`;
}
