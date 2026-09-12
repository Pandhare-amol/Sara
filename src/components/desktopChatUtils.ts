import type { DesktopConversationRecord } from "../lib/desktopConversationStore";

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
