import type { AgiContextItem } from "./types";
import type { MemoryKind } from "./advanced-types";

export interface AdvancedMemory extends AgiContextItem { kind: MemoryKind; associations: string[]; importance: number; expiresAt?: number; }

export class AdvancedMemoryStore {
  private readonly items = new Map<string, AdvancedMemory>();
  remember(item: Omit<AdvancedMemory, "id" | "createdAt" | "updatedAt">): AdvancedMemory { const now = Date.now(); const saved = { ...item, id: `${item.sessionId}-${now}-${Math.random().toString(36).slice(2)}`, createdAt: now, updatedAt: now }; this.items.set(saved.id, saved); return saved; }
  recall(kind?: MemoryKind, sessionId?: string): AdvancedMemory[] { return [...this.items.values()].filter((item) => (!kind || item.kind === kind) && (!sessionId || item.sessionId === sessionId) && (!item.expiresAt || item.expiresAt > Date.now())).sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt); }
  associate(id: string, relatedId: string): void { const item = this.items.get(id); if (item && !item.associations.includes(relatedId)) item.associations.push(relatedId); }
  deleteExpired(now = Date.now()): number { let count = 0; for (const [id, item] of this.items) if (item.expiresAt && item.expiresAt <= now) { this.items.delete(id); count++; } return count; }
}
