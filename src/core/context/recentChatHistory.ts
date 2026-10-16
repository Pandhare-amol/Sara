export type RecentChatTurn = { role: "user" | "assistant"; text: string };

/** Transport/prompt window, not the saved conversation. Never truncate the user's current message. */
export function recentChatHistory(input: unknown): RecentChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns: RecentChatTurn[] = [];
  let remaining = 8_000;
  // Inspect only a bounded tail even if an old desktop conversation contains years of messages.
  for (let index = input.length - 1, inspected = 0; index >= 0 && inspected < 30 && turns.length < 10; index--, inspected++) {
    const item = input[index];
    if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.text !== "string") continue;
    const fullText = item.text.trim();
    if (!fullText) continue;
    const text = fullText.length > 1_600
      ? `${fullText.slice(0, 300)}\n[Middle text omitted]\n${fullText.slice(-1_270)}`
      : fullText;
    if (text.length > remaining) break;
    turns.push({ role: item.role, text });
    remaining -= text.length;
  }
  return turns.reverse();
}
