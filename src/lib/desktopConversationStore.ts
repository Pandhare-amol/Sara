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
  return loadStored();
}

export async function getDesktopConversation(conversationId: string): Promise<DesktopConversationRecord | null> {
  return loadStored().find((item) => item.id === conversationId) ?? null;
}

export async function saveDesktopConversation(conversation: DesktopConversationRecord): Promise<DesktopConversationRecord> {
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
