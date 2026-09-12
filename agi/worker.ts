import { AgiService } from "./service";

export interface AgiWorkerMessage { id: string; input: string; sessionId: string; }
export interface AgiWorkerResponse { id: string; text: string | null; }
export interface AgiWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<AgiWorkerMessage>) => void): void;
  postMessage(message: AgiWorkerResponse): void;
}

export function attachAgiWorker(service: AgiService, scope: AgiWorkerScope): void {
  scope.addEventListener("message", async (event: MessageEvent<AgiWorkerMessage>) => {
    const result = await service.generate({ input: event.data.input, sessionId: event.data.sessionId });
    scope.postMessage({ id: event.data.id, text: result?.text ?? null } satisfies AgiWorkerResponse);
  });
}
