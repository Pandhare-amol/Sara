export type AgiEventMap = {
  "agi:enabled": { enabled: boolean };
  "agi:input": { sessionId: string; input: string };
  "agi:insight": { sessionId: string; insight: unknown };
  "agi:response": { sessionId: string; text: string; provider: string };
  "agi:error": { sessionId?: string; error: Error };
};

export class AgiEventBus {
  private readonly listeners = new Map<keyof AgiEventMap, Set<(payload: never) => void>>();

  on<K extends keyof AgiEventMap>(event: K, listener: (payload: AgiEventMap[K]) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (payload: never) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof AgiEventMap>(event: K, payload: AgiEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }
}
