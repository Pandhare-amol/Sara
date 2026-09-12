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
  summary?: string;
  activeContext?: Record<string, unknown>;
  taskState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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

export function normalizeConversation(item: any): DesktopConversationRecord | null {
  if (!item) return null;
  const id = String(item.id ?? item.conversation_id ?? item.conversationId ?? "").trim();
  if (!id) return null;
  const messages = Array.isArray(item.messages) ? item.messages.map((message: any, index: number) => {
    const text = typeof message?.text === "string" ? message.text : typeof message?.content === "string" ? message.content : "";
    const timestamp = message?.timestamp || message?.createdAt || message?.created_at || new Date().toISOString();
    const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "assistant";
    return {
      role,
      text,
      timestamp,
      id: message?.id || message?.message_id || `msg-${index}-${id}`,
    };
  }) : [];
  return {
    id,
    title: item.title || "Desktop chat with SARA",
    updatedAt: item.updatedAt || item.updated_at || new Date().toISOString(),
    messages,
    summary: item.summary || "",
    activeContext: item.activeContext || item.active_context || {},
    taskState: item.taskState || item.task_state || {},
    metadata: item.metadata || {},
  };
}

export async function getDesktopConversations(): Promise<DesktopConversationRecord[]> {
  try {
    const res = await fetch("/api/conversations?source=desktop", { cache: "no-store" });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items)) {
        return (items.map((item) => normalizeConversation(item)).filter(Boolean) as DesktopConversationRecord[]).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      }
    }
  } catch {}
  return loadStored().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function searchDesktopConversations(query: string): Promise<DesktopConversationRecord[]> {
  const normalized = query.trim();
  if (!normalized) return getDesktopConversations();

  try {
    const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(normalized)}&source=desktop`, { cache: "no-store" });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items)) {
        return (items.map((item) => normalizeConversation(item)).filter(Boolean) as DesktopConversationRecord[])
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      }
    }
  } catch {}

  const all = loadStored();
  const lower = normalized.toLowerCase();
  return all
    .filter((item) => {
      const preview = item.messages.map((message) => message.text).join(" ");
      return item.title.toLowerCase().includes(lower) || preview.toLowerCase().includes(lower);
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getDesktopConversation(conversationId: string): Promise<DesktopConversationRecord | null> {
  try {
    const res = await fetch(`/api/conversations?source=desktop`, { cache: "no-store" });
    if (res.ok) {
      const items = await res.json();
      const found = Array.isArray(items)
        ? items.find((item: any) => String(item.id ?? item.conversation_id ?? item.conversationId ?? "") === String(conversationId))
        : null;
      if (found) return normalizeConversation(found) as DesktopConversationRecord;
    }
  } catch {}
  return loadStored().find((item) => String(item.id ?? item.metadata?.conversationId ?? "") === String(conversationId)) ?? null;
}

export async function restoreDesktopConversation(conversationId: string): Promise<DesktopConversationRecord | null> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/restore`, { cache: "no-store" });
    if (!res.ok) return getDesktopConversation(conversationId);
    const payload = await res.json();
    const conversation = payload.conversation || payload;
    const normalized = normalizeConversation(conversation);
    if (normalized) {
      const all = loadStored();
      const index = all.findIndex((item) => item.id === normalized.id);
      if (index >= 0) all[index] = normalized; else all.unshift(normalized);
      saveStored(all);
      return normalized;
    }
  } catch {}
  return getDesktopConversation(conversationId);
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
    summary: "Fresh conversation initialized.",
    activeContext: {
      objective: title,
      status: "new",
    },
    taskState: {
      status: "new",
    },
    metadata: {
      source: "desktop",
    },
  };
}
