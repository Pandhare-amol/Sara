// src/services/DesktopAgentResultAdapter.ts
/**
 * Adapter to normalize the raw output from the Python desktop agent.
 * All service classes (MouseController, KeyboardController, WindowManager, etc.)
 * execute a Python script via {@code execFileAsync} and receive the stdout as a string.
 * Historically the Python side printed plain values or nothing on success,
 * and errors were emitted to stderr causing the caller to throw.
 *
 * The new contract requires a deterministic JSON payload regardless of success
 * or failure so that the frontend can reliably distinguish between execution
 * success, verification success, and actual errors.
 *
 * Expected Python output (example):
 *   { "success": true, "data": { "x": 100, "y": 200 } }
 *   { "success": false, "error": "Window not found" }
 *
 * This adapter parses the raw string, validates the shape, and returns a typed
 * result. If parsing fails, it treats the response as a failure with the raw
 * output attached for debugging.
 */
export interface DesktopAgentResult<T = any> {
  /** Indicates whether the underlying Python call succeeded */
  success: boolean;
  /** Payload returned by the Python script on success */
  data?: T;
  /** Human‑readable error description when {@link success} is false */
  error?: string;
  /** Raw stdout captured from the Python process (useful for diagnostics) */
  raw: string;
}

/**
 * Normalises the raw stdout from a Python script.
 *
 * @param raw - The exact stdout string returned by {@code execFileAsync}.
 * @returns A {@link DesktopAgentResult} with a guaranteed shape.
 */
export function adaptDesktopAgentResult<T = any>(raw: string): DesktopAgentResult<T> {
  const trimmed = raw.trim();
  // Preserve raw output for debugging regardless of outcome.
  const base = { raw: trimmed } as DesktopAgentResult<T>;

  if (!trimmed) {
    // Empty output is ambiguous – treat as failure.
    return { ...base, success: false, error: 'Empty response from desktop agent' };
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<DesktopAgentResult<T>>;
    // Ensure the mandatory "success" flag exists and is boolean.
    if (typeof parsed.success !== 'boolean') {
      throw new Error('Missing or invalid \"success\" field');
    }
    // Merge parsed fields, falling back to defaults.
    return {
      success: parsed.success,
      data: parsed.success ? parsed.data : undefined,
      error: parsed.success ? undefined : parsed.error ?? 'Unknown error from desktop agent',
      raw: trimmed,
    } as DesktopAgentResult<T>;
  } catch (e: any) {
    // JSON parsing failed – encapsulate the raw output as an error.
    return {
      ...base,
      success: false,
      error: `Invalid JSON from desktop agent: ${e.message}`,
    };
  }
}

/**
 * Helper to unwrap a successful result or throw a descriptive error.
 * Most service callers can use this to get the concrete payload while
 * preserving a uniform error handling strategy.
 */
export function unwrapResult<T>(result: DesktopAgentResult<T>): T {
  if (result.success) {
    return result.data as T;
  }
  // Throw a rich error that includes both the parsed error and the raw output.
  const errMsg = result.error ? `${result.error}` : 'Desktop agent reported failure';
  throw new Error(`${errMsg}\nRaw output: ${result.raw}`);
}
