/**
 * Optional, opt-in inferred-memory work is not part of the chat response.
 * Yield after the response is written, handle failures, and never forward inferred
 * memories as approved facts. The caller still owns the consent gate and storage.
 */
export function scheduleMemoryExtraction(run: () => Promise<unknown>, onError: () => void = () => {}): void {
  setImmediate(() => {
    void Promise.resolve().then(run).catch(() => {
      try { onError(); } catch { /* diagnostics must not produce an unhandled rejection */ }
    });
  });
}
