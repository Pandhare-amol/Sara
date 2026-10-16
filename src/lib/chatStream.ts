import { readSseData } from "../core/models/sseStream";

export interface ChatStreamMetrics {
  ackMs: number;
  firstTextMs: number | null;
  completionMs: number;
  modelMs: number | null;
  streamed: boolean;
  fallback: boolean;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssMb: number;
}

export interface ChatStreamCompletion {
  ok: true;
  text: string;
  conversationId: string | null;
  userId: string;
  temporary?: boolean;
  metrics: ChatStreamMetrics;
}

export class ChatStreamError extends Error {
  constructor(message: string, public readonly code: string, public readonly partial: boolean) {
    super(message);
    this.name = "ChatStreamError";
  }
}

/** The final done event, not a text delta, is the only evidence of persistence. */
export async function readChatStream(response: Response, onDelta: (text: string) => void): Promise<ChatStreamCompletion> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ChatStreamError("The server did not return a text stream.", "INVALID_RESPONSE", false);
  }
  let complete: ChatStreamCompletion | null = null;
  let partialText = "";
  await readSseData(response.body, (raw, type) => {
    if (complete) throw new ChatStreamError("Unexpected data after completion.", "INVALID_RESPONSE", true);
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); }
    catch { throw new ChatStreamError("Invalid response framing.", "INVALID_RESPONSE", Boolean(partialText)); }
    if (!data || typeof data !== "object") throw new ChatStreamError("Invalid response framing.", "INVALID_RESPONSE", Boolean(partialText));
    if (type === "ack") return;
    if (type === "text") {
      if (typeof data.text !== "string" || data.text.length > 32_768) throw new ChatStreamError("Invalid response text.", "INVALID_RESPONSE", Boolean(partialText));
      partialText += data.text;
      if (partialText.length > 65_536) throw new ChatStreamError("Response is too long.", "INVALID_RESPONSE", true);
      onDelta(data.text);
      return;
    }
    if (type === "error") throw new ChatStreamError(
      typeof data.error === "string" ? data.error : "Response interrupted; not saved.",
      typeof data.code === "string" ? data.code : "CHAT_FAILED", Boolean(data.partial) || Boolean(partialText));
    if (type === "done") {
      if (data.ok !== true || typeof data.text !== "string" || typeof data.userId !== "string" ||
          !data.metrics || typeof data.metrics !== "object" ||
          (data.conversationId !== null && typeof data.conversationId !== "string") ||
          data.text.trim() !== partialText.trim()) {
        throw new ChatStreamError("Response completion could not be verified.", "INVALID_RESPONSE", Boolean(partialText));
      }
      complete = data as unknown as ChatStreamCompletion;
    }
  });
  if (!complete) throw new ChatStreamError("Response ended before completion; partial text was not saved.", "INTERRUPTED", Boolean(partialText));
  return complete;
}
