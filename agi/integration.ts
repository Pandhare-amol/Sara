import type { AgiService } from "./service";
import type { AgiGenerationRequest } from "./types";

export interface AgiMiddlewareRequest { sessionId: string; userId?: string; input: string; [key: string]: unknown; }
export type AgiMiddleware = (request: AgiMiddlewareRequest, next: (request: AgiMiddlewareRequest) => Promise<unknown>) => Promise<unknown>;

export function createAgiMiddleware(service: AgiService): AgiMiddleware {
  return async (request, next) => {
    if (!service.isEnabled()) return next(request);
    const insight = await service.analyze(request.input, request.sessionId, request.userId);
    return next({ ...request, agiInsight: insight });
  };
}

export function wrapFunction<TArgs extends unknown[], TResult>(service: AgiService, sessionId: string, fn: (...args: TArgs) => Promise<TResult> | TResult): (...args: TArgs) => Promise<TResult> {
  return async (...args) => {
    const input = String(args[0] ?? "");
    if (service.isEnabled()) await service.analyze(input, sessionId);
    const result = await fn(...args);
    if (service.isEnabled()) service.events.emit("agi:response", { sessionId, text: JSON.stringify(result), provider: "custom" });
    return result;
  };
}

export function createAgiProxy<T extends object>(service: AgiService, target: T, sessionId: string): T {
  return new Proxy(target, { get(object, property, receiver) { const value = Reflect.get(object, property, receiver); return typeof value === "function" ? wrapFunction(service, sessionId, value.bind(object)) : value; } });
}

export async function enhanceInput(service: AgiService, request: AgiGenerationRequest): Promise<AgiGenerationRequest> {
  if (!service.isEnabled()) return request;
  const insight = await service.analyze(request.input, request.sessionId, request.userId);
  return { ...request, input: `${request.input}\n\n[Optional AGI context: intent=${insight.intent ?? "unknown"}; sentiment=${insight.sentiment ?? "unknown"}]` };
}
