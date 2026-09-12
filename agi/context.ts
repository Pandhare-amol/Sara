import type { AgiContextItem } from "./types";

export interface VectorStore {
  search(query: string, limit: number, userId?: string): Promise<AgiContextItem[]>;
  upsert(item: AgiContextItem): Promise<void>;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly items = new Map<string, AgiContextItem>();
  async search(query: string, limit: number, userId?: string): Promise<AgiContextItem[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.items.values()]
      .filter((item) => !userId || item.userId === userId)
      .map((item) => ({ item, score: terms.filter((term) => item.content.toLowerCase().includes(term)).length }))
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit).map(({ item }) => item);
  }
  async upsert(item: AgiContextItem): Promise<void> { this.items.set(item.id, item); }
}

export class IndexedDbVectorStore implements VectorStore {
  private readonly fallback = new InMemoryVectorStore();
  private database?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = "sara-agi-context", private readonly storeName = "context") {}

  async search(query: string, limit: number, userId?: string): Promise<AgiContextItem[]> {
    const database = await this.open();
    if (!database) return this.fallback.search(query, limit, userId);
    const items = await new Promise<AgiContextItem[]>((resolve, reject) => {
      const request = database.transaction(this.storeName, "readonly").objectStore(this.storeName).getAll();
      request.onsuccess = () => resolve(request.result as AgiContextItem[]);
      request.onerror = () => reject(request.error);
    });
    const index = new InMemoryVectorStore();
    await Promise.all(items.map((item) => index.upsert(item)));
    return index.search(query, limit, userId);
  }

  async upsert(item: AgiContextItem): Promise<void> {
    const database = await this.open();
    if (!database) return this.fallback.upsert(item);
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(this.storeName, "readwrite").objectStore(this.storeName).put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private open(): Promise<IDBDatabase | undefined> {
    if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(this.storeName, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(() => undefined);
    return this.database;
  }
}

export class ContextManager {
  constructor(private readonly store: VectorStore = new InMemoryVectorStore(), private readonly maxItems = 50) {}
  async retrieve(query: string, userId?: string): Promise<AgiContextItem[]> { return this.store.search(query, this.maxItems, userId); }
  async remember(sessionId: string, content: string, tags: string[] = [], category = "conversation", userId?: string): Promise<AgiContextItem> {
    const now = Date.now();
    const item: AgiContextItem = { id: `${sessionId}-${now}-${Math.random().toString(36).slice(2)}`, sessionId, userId, content, tags, category, createdAt: now, updatedAt: now };
    await this.store.upsert(item);
    return item;
  }
  summarize(messages: { role: string; content: string }[], maxCharacters: number): string {
    const text = messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    return text.length <= maxCharacters ? text : `${text.slice(0, Math.max(0, maxCharacters - 24))}\n[context summarized]`;
  }
}
