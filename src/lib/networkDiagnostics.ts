/**
 * Network Diagnostics and Error Classification
 * Helps identify and classify Chromium/network errors
 */

export type NetworkErrorType =
  | "transient"
  | "request-construction" 
  | "stream-lifecycle"
  | "timeout"
  | "connection-refused"
  | "server-error"
  | "cancellation"
  | "unknown";

export interface NetworkErrorClassification {
  type: NetworkErrorType;
  message: string;
  retryable: boolean;
  advice: string;
}

export function classifyNetworkError(
  error: Error | string,
  statusCode?: number
): NetworkErrorClassification {
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes("OnSizeReceived") || msg.includes("-2")) {
    return {
      type: "stream-lifecycle",
      message: "Chromium OnSizeReceived error - chunked encoding mismatch",
      retryable: true,
      advice: "Verify Content-Length and avoid overlapping health requests"
    };
  }

  if (msg.includes("timeout") || msg.includes("TIMEOUT")) {
    return {
      type: "timeout",
      message: "Request exceeded timeout",
      retryable: true,
      advice: "Increase timeout or improve network conditions"
    };
  }

  if (msg.includes("ECONNREFUSED") || msg.includes("connection refused")) {
    return {
      type: "connection-refused",
      message: "Connection refused by remote server",
      retryable: true,
      advice: "Verify service is running on correct port"
    };
  }

  if (msg.includes("ENOTFOUND") || msg.includes("not found")) {
    return {
      type: "connection-refused",
      message: "Unable to resolve hostname",
      retryable: false,
      advice: "Check DNS resolution and service availability"
    };
  }

  if (statusCode && statusCode >= 500) {
    return {
      type: "server-error",
      message: `Server error: ${statusCode}`,
      retryable: true,
      advice: "Retry after delay"
    };
  }

  if (statusCode && statusCode >= 400) {
    return {
      type: "request-construction",
      message: `Client error: ${statusCode}`,
      retryable: false,
      advice: "Verify request is properly constructed"
    };
  }

  if (msg.includes("AbortError") || msg.includes("canceled")) {
    return {
      type: "cancellation",
      message: "Request was cancelled",
      retryable: false,
      advice: "No action if cancellation was intentional"
    };
  }

  return {
    type: "transient",
    message: msg,
    retryable: true,
    advice: "Retry with exponential backoff"
  };
}

export class ErrorRateLimiter {
  private seen = new Map<string, number>();
  
  constructor(private windowMs = 60000) {}

  should(key: string): boolean {
    const now = Date.now();
    const last = this.seen.get(key);
    if (!last || now - last > this.windowMs) {
      this.seen.set(key, now);
      return true;
    }
    return false;
  }
}
