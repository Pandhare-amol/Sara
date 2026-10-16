import type { DesktopConversationRecord, DesktopChatMessage } from "../lib/desktopConversationStore";

export function mergePendingVoiceTurns(conversation: DesktopConversationRecord, pending: DesktopChatMessage[]): DesktopConversationRecord {
  if (!pending.length) return conversation;
  const messages = [...conversation.messages];
  const seen = new Set(messages.map((turn) => `${turn.role}\0${turn.timestamp}\0${turn.text}`));
  for (const turn of pending) {
    const key = `${turn.role}\0${turn.timestamp}\0${turn.text}`;
    if (!seen.has(key)) { seen.add(key); messages.push(turn); }
  }
  return { ...conversation, messages };
}

export function canSendMessage(input: string, sending: boolean, conversation: DesktopConversationRecord | null): boolean {
  return Boolean(conversation && !sending && input.trim().length > 0);
}

export function shouldApplyConversationResponse(
  requestConversationId: string | null,
  currentConversationId: string | null,
): boolean {
  const requestId = requestConversationId?.trim();
  const currentId = currentConversationId?.trim();

  if (!requestId || !currentId) {
    return false;
  }

  return requestId === currentId;
}
