import {
  loadMemories,
  saveMemories,
  searchMemories,
  upsertMemory,
  type StoredMemory,
} from "../../server_memory";
import {
  appendConversationMessage,
  getRecentConversationMessages,
  type ConversationMessage,
} from "../../server_state";
import { type MemoryCategory } from "../lib/memoryTypes";

export interface MemoryRecord {
  id: string;
  category: string;
  key?: string;
  value: string;
  importance?: number;
  confidence?: number;
  source?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessed?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRepository {
  saveMemory(memory: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<MemoryRecord, "id" | "createdAt" | "updatedAt">>): Promise<MemoryRecord>;
  getMemory(id: string): Promise<MemoryRecord | null>;
  searchMemory(query: string, limit?: number): Promise<MemoryRecord[]>;
  deleteMemory(id: string): Promise<boolean>;
  saveConversation(message: ConversationMessage): Promise<void>;
  getRecentConversation(conversationId: string, limit?: number): Promise<ConversationMessage[]>;
  searchConversation(conversationId: string, query: string, limit?: number): Promise<ConversationMessage[]>;
}

function toRecord(memory: StoredMemory): MemoryRecord {
  const metadata = (memory as StoredMemory & { metadata?: Record<string, unknown> }).metadata || {};
  return {
    id: String(memory.id),
    category: String(memory.category || "general"),
    key: typeof metadata.key === "string" ? metadata.key : undefined,
    value: String(memory.text || ""),
    importance: memory.importance,
    confidence: typeof metadata.confidence === "number" ? metadata.confidence : undefined,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastAccessed: memory.lastReferencedAt,
    metadata,
  };
}

function toStoredMemory(memory: MemoryRecord): StoredMemory {
  // Validate category is one of the allowed types, default to 'identity' if not
  const validCategories: MemoryCategory[] = [
    "identity",
    "preference",
    "goal",
    "project",
    "relationship",
    "emotional",
    "behavior",
  ];
  const category = (validCategories.includes(memory.category as MemoryCategory)
    ? (memory.category as MemoryCategory)
    : "identity") as MemoryCategory;

  return {
    id: memory.id,
    category,
    text: memory.value,
    importance: memory.importance ?? 5,
    source: "desktop",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastReferencedAt: memory.lastAccessed,
    keywords: [memory.category, memory.key || "", memory.value]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((part) => part.length > 2)
      .slice(0, 32),
  };
}

class ExistingStoreMemoryRepository implements MemoryRepository {
  async saveMemory(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<MemoryRecord, "id" | "createdAt" | "updatedAt">>): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: input.id || Math.random().toString(36).slice(2, 11),
      category: input.category,
      key: input.key,
      value: input.value,
      importance: input.importance ?? 5,
      confidence: input.confidence,
      source: input.source || "local",
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      lastAccessed: input.lastAccessed,
      metadata: { ...(input.metadata || {}), key: input.key, confidence: input.confidence },
    };
    const updated = await upsertMemory(toStoredMemory(record));
    const saved = updated.find((item) => item.id === record.id) || updated.find((item) => item.category === record.category && item.text === record.value);
    return toRecord(saved || toStoredMemory(record));
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    const memories = await loadMemories();
    const found = memories.find((memory) => memory.id === id);
    return found ? toRecord(found) : null;
  }

  async searchMemory(query: string, limit = 8): Promise<MemoryRecord[]> {
    return (await searchMemories(query, "desktop", limit)).map(toRecord);
  }

  async deleteMemory(id: string): Promise<boolean> {
    const memories = await loadMemories();
    const next = memories.filter((memory) => memory.id !== id);
    if (next.length === memories.length) return false;
    await saveMemories(next);
    return true;
  }

  async saveConversation(message: ConversationMessage): Promise<void> {
    await appendConversationMessage(message);
  }

  async getRecentConversation(conversationId: string, limit = 20): Promise<ConversationMessage[]> {
    return getRecentConversationMessages(conversationId, limit);
  }

  async searchConversation(conversationId: string, query: string, limit = 20): Promise<ConversationMessage[]> {
    const normalized = query.toLowerCase();
    return (await this.getRecentConversation(conversationId, Math.max(limit, 100)))
      .filter((message) => message.content.toLowerCase().includes(normalized))
      .slice(0, limit);
  }
}

let repository: MemoryRepository | null = null;

export function getMemoryRepository(): MemoryRepository {
  if (!repository) repository = new ExistingStoreMemoryRepository();
  return repository;
}

export function resetMemoryRepositoryForTests(): void {
  repository = null;
}
