export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationMessage = {
  message_id: string;
  conversation_id: string;
  role: ConversationRole;
  content: string;
  timestamp: string;
  attachments: Array<Record<string, unknown>>;
  tool_calls: Array<Record<string, unknown>>;
  tool_results: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  parent_message_id: string | null;
};

export type ConversationRecord = {
  id?: string;
  conversation_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  status: "active" | "archived" | "deleted";
  model_provider: string;
  summary: string;
  active_context: Record<string, unknown>;
  task_state: Record<string, unknown>;
  memory_scope: string[];
  metadata: Record<string, unknown>;
};

export type ConversationRepository = {
  createConversation: (input?: Partial<ConversationRecord>) => Promise<ConversationRecord>;
  getConversation: (conversationId: string) => Promise<ConversationRecord | null>;
  listConversations: () => Promise<ConversationRecord[]>;
  updateConversation: (conversationId: string, patch: Partial<ConversationRecord>) => Promise<ConversationRecord>;
  deleteConversation: (conversationId: string) => Promise<boolean>;
  searchConversations: (query: string) => Promise<ConversationRecord[]>;
  appendMessage: (conversationId: string, message: ConversationMessage) => Promise<ConversationMessage>;
  getMessages: (conversationId: string) => Promise<ConversationMessage[]>;
  updateConversationSummary: (conversationId: string, summary: string) => Promise<ConversationRecord>;
  saveContextSnapshot: (conversationId: string, snapshot: Record<string, unknown>) => Promise<ConversationRecord>;
  restoreContextSnapshot: (conversationId: string) => Promise<Record<string, unknown> | null>;
};

const DEFAULT_USER_ID = "default-user";

function stableId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toConversationModel(input: Partial<ConversationRecord> = {}): ConversationRecord {
  const now = new Date().toISOString();
  const conversationId = input.conversation_id ?? input.id ?? stableId("conv");
  const record: ConversationRecord = {
    id: conversationId,
    conversation_id: conversationId,
    user_id: input.user_id ?? DEFAULT_USER_ID,
    title: input.title ?? "New conversation",
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    last_message_at: input.last_message_at ?? null,
    status: input.status ?? "active",
    model_provider: input.model_provider ?? "gemini",
    summary: input.summary ?? "",
    active_context: input.active_context ?? {},
    task_state: input.task_state ?? {},
    memory_scope: input.memory_scope ?? [],
    metadata: input.metadata ?? {},
  };
  return record;
}

export function createConversationRepository(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): ConversationRepository {
  const baseUrl = options.baseUrl ?? "";
  const fetchFn = options.fetchImpl ?? fetch;
  const memory = new Map<string, ConversationRecord>();
  const messageMap = new Map<string, ConversationMessage[]>();

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const response = await fetchFn(url, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  return {
    async createConversation(input = {}) {
      const record = toConversationModel(input);
      memory.set(record.conversation_id, record);
      messageMap.set(record.conversation_id, []);

      try {
        const payload = { conversation: record, source: "desktop" };
        const result = await request<{ ok: boolean; conversation: ConversationRecord }>("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const persisted = toConversationModel(result.conversation ?? record);
        memory.set(persisted.conversation_id, persisted);
        return persisted;
      } catch {
        return record;
      }
    },

    async getConversation(conversationId) {
      if (memory.has(conversationId)) return memory.get(conversationId)!;
      try {
        const items = await request<ConversationRecord[]>("/api/conversations");
        const found = items.find((item) => (item.conversation_id ?? item.id ?? "") === conversationId) ?? null;
        if (found) {
          const normalized = toConversationModel(found);
          memory.set(conversationId, normalized);
          return normalized;
        }
      } catch {}
      return null;
    },

    async listConversations() {
      try {
        const items = await request<ConversationRecord[]>("/api/conversations");
        const normalized = items.map((item) => toConversationModel(item));
        normalized.forEach((item) => memory.set(item.conversation_id, item));
        return normalized;
      } catch {
        return Array.from(memory.values());
      }
    },

    async updateConversation(conversationId, patch) {
      const existing = (await this.getConversation(conversationId)) ?? toConversationModel({ conversation_id: conversationId });
      const next = toConversationModel({ ...existing, ...patch, updated_at: new Date().toISOString() });
      memory.set(conversationId, next);
      try {
        await request(`/api/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation: next, source: "desktop" }),
        });
      } catch {}
      return next;
    },

    async deleteConversation(conversationId) {
      memory.delete(conversationId);
      messageMap.delete(conversationId);
      try {
        await request(`/api/conversations/${conversationId}?source=desktop`, { method: "DELETE" });
        return true;
      } catch {
        return false;
      }
    },

    async searchConversations(query) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return await this.listConversations();
      const list = await this.listConversations();
      return list.filter((conversation) => {
        const haystack = [
          conversation.title,
          conversation.summary,
          conversation.memory_scope.join(" "),
          JSON.stringify(conversation.active_context),
          JSON.stringify(conversation.task_state),
        ].join(" ").toLowerCase();
        return haystack.includes(normalized);
      });
    },

    async appendMessage(conversationId, message) {
      const list = messageMap.get(conversationId) ?? [];
      const next = [...list, message];
      messageMap.set(conversationId, next);
      const conversation = (await this.getConversation(conversationId)) ?? toConversationModel({ conversation_id: conversationId });
      conversation.updated_at = message.timestamp;
      conversation.last_message_at = message.timestamp;
      memory.set(conversationId, conversation);
      return message;
    },

    async getMessages(conversationId) {
      if (messageMap.has(conversationId)) return messageMap.get(conversationId)!;
      const conversation = await this.getConversation(conversationId);
      if (conversation) {
        const messages = messageMap.get(conversationId) ?? [];
        if (messages.length) {
          return messages;
        }
        return [];
      }
      return [];
    },

    async updateConversationSummary(conversationId, summary) {
      const existing = (await this.getConversation(conversationId)) ?? toConversationModel({ conversation_id: conversationId });
      const next = toConversationModel({ ...existing, summary, updated_at: new Date().toISOString() });
      memory.set(conversationId, next);
      return next;
    },

    async saveContextSnapshot(conversationId, snapshot) {
      const existing = (await this.getConversation(conversationId)) ?? toConversationModel({ conversation_id: conversationId });
      const next = toConversationModel({ ...existing, active_context: snapshot, updated_at: new Date().toISOString() });
      memory.set(conversationId, next);
      return next;
    },

    async restoreContextSnapshot(conversationId) {
      const existing = await this.getConversation(conversationId);
      return existing?.active_context ?? null;
    },
  };
}
