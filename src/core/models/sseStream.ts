export class SseFrameError extends Error {}

/** Parse UTF-8 server-sent events across arbitrary network chunk boundaries. */
export async function readSseData(
  body: ReadableStream<Uint8Array>,
  onData: (data: string, eventType?: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const dispatch = (frame: string) => {
    if (frame.length > 128_000) throw new SseFrameError("SSE frame too large");
    const data: string[] = [];
    let eventType: string | undefined;
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) eventType = line.slice(6).trim();
    }
    if (data.length) onData(data.join("\n"), eventType);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        dispatch(frame);
        boundary = pending.indexOf("\n\n");
      }
      if (pending.length > 128_000) throw new SseFrameError("SSE frame too large");
      if (done) break;
    }
    if (pending.trim()) dispatch(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
