// src/core/events/EventBus.ts
// Simple event bus used across SARA for broadcasting and listening to events.

import { EventEmitter } from 'events';

export type EventPayload = unknown;

export class EventBus extends EventEmitter {
  private static _instance: EventBus | null = null;

  private constructor() {
    super();
  }

  public static get instance(): EventBus {
    if (!EventBus._instance) {
      EventBus._instance = new EventBus();
    }
    return EventBus._instance;
  }

  /** Emit a typed event */
  public emitEvent(eventName: string, payload: EventPayload): boolean {
    return super.emit(eventName, payload);
  }

  /** Subscribe to an event */
  public onEvent(eventName: string, listener: (payload: EventPayload) => void): this {
    super.on(eventName, listener);
    return this;
  }
}
