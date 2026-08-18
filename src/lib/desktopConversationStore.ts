export type DesktopChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type DesktopConversationRecord = {
  id: string;
  title: string;
  updatedAt: string;
  messages: DesktopChatMessage[];
};

const STORAGE_KEY = "sara_desktop_conversations";

function loadStored(): DesktopConversationRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DesktopConversationRecord[];
  } catch {
    return [];
  }
}

function saveStored(conversations: DesktopConversationRecord[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // ignore storage errors
  }
}

export async function getDesktopConversations(): Promise<DesktopConversationRecord[]> {
  try {
    const res = await fetch("/api/conversations?source=desktop", { cache: "no-store" });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items)) {
        return items as DesktopConversationRecord[];
      }
    }
  } catch {}
  return loadStored();
}

export async function getDesktopConversation(conversationId: string): Promise<DesktopConversationRecord | null> {
  try {
    const res = await fetch(`/api/conversations?source=desktop`, { cache: "no-store" });
    if (res.ok) {
      const items = await res.json();
      const found = Array.isArray(items) ? items.find((item: any) => item.id === conversationId) : null;
      if (found) return found as DesktopConversationRecord;
    }
  } catch {}
  return loadStored().find((item) => item.id === conversationId) ?? null;
}

export async function saveDesktopConversation(conversation: DesktopConversationRecord): Promise<DesktopConversationRecord> {
  const payload = { source: "desktop", conversation };
  try {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const saved = await res.json().catch(() => null);
      if (saved?.conversation) {
        const all = loadStored();
        const index = all.findIndex((item) => item.id === conversation.id);
        const next = index >= 0 ? [...all.slice(0, index), saved.conversation, ...all.slice(index + 1)] : [saved.conversation, ...all];
        saveStored(next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
        return saved.conversation as DesktopConversationRecord;
      }
    }
  } catch {}

  const all = loadStored();
  const index = all.findIndex((item) => item.id === conversation.id);
  if (index >= 0) {
    all[index] = conversation;
  } else {
    all.unshift(conversation);
  }
  all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  saveStored(all);
  return conversation;
}

export async function deleteDesktopConversation(conversationId: string): Promise<void> {
  const all = loadStored().filter((item) => item.id !== conversationId);
  saveStored(all);
}

export function createDesktopConversation(title = "Desktop chat with SARA"): DesktopConversationRecord {
  return {
    id: `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    title,
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}
