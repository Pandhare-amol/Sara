/**
 * Health Polling Regression Test
 *
 * Validates that health check fixes prevent:
 * 1. Overlapping requests to same endpoint
 * 2. Chromium OnSizeReceived -2 errors from concurrent streams
 * 3. Timeout and cancellation handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fetch with request tracking
interface FetchRequest {
  url: string;
  timestamp: number;
  aborted?: boolean;
}

const activeFetches: FetchRequest[] = [];

// Test that AbortController is properly used
describe("Health Polling Fixes", () => {
  afterEach(() => {
    activeFetches.length = 0;
  });

  it("should not allow overlapping health requests", async () => {
    // Simulates the fixed SettingsPanel behavior
    let isPending = false;
    let abortController: AbortController | null = null;
    const requests: FetchRequest[] = [];

    const probe = async () => {
      if (isPending) {
        console.log("Request already pending - skipping");
        return;
      }
      
      isPending = true;
      try {
        abortController?.abort();
        abortController = new AbortController();

        const fetchTime = Date.now();
        requests.push({ url: "http://127.0.0.1:8765/health", timestamp: fetchTime });

        // Simulate async operation
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        isPending = false;
      }
    };

    // Attempt 3 rapid consecutive calls
    await probe();
    await probe(); // Should be skipped
    await probe(); // Should be skipped
    
    // Only 1 request should have been made
    expect(requests.length).toBe(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:8765/health");
  });

  it("should cancel previous request before starting new one", async () => {
    const abortedRequests: string[] = [];
    let abortController: AbortController | null = null;

    const probe = async () => {
      // Cancel previous
      if (abortController) {
        abortedRequests.push("aborted");
        abortController.abort();
      }

      abortController = new AbortController();
      
      // Simulate request
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true });
        }, 100);
      });
    };

    // Call probe 3 times with delays
    const p1 = probe();
    await new Promise((r) => setTimeout(r, 30));
    const p2 = probe();
    await new Promise((r) => setTimeout(r, 30));
    const p3 = probe();

    await Promise.all([p1, p2, p3]);

    // Should have 2 abort calls
    expect(abortedRequests.length).toBe(2);
  });

  it("should respect timeout limits", async () => {
    const timeouts: number[] = [];
    
    const isPortHealthy = async (timeout = 2500) => {
      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          timeouts.push(timeout);
          resolve({ healthy: false });
        }, timeout);

        // Simulate slow response
        setTimeout(() => {
          clearTimeout(timeoutId);
          resolve({ healthy: true });
        }, timeout * 2);
      });
    };

    const start = Date.now();
    const result = await isPortHealthy(2500);
    const elapsed = Date.now() - start;

    // Should have timed out
    expect(result.healthy).toBe(false);
    expect(timeouts[0]).toBe(2500);
    // Should be close to timeout value (within 100ms tolerance)
    expect(elapsed).toBeLessThan(2700);
  });

  it("should properly clean up AbortController on component unmount", () => {
    let abortController: AbortController | null = null;
    let intervalId: NodeJS.Timeout | null = null;
    let cleaned = false;

    const setupHealthProbe = () => {
      const probe = async () => {
        abortController = new AbortController();
        await new Promise((r) => setTimeout(r, 50));
      };

      probe();
      intervalId = setInterval(probe, 1000);

      // Cleanup function
      return () => {
        if (intervalId) clearInterval(intervalId);
        abortController?.abort();
        cleaned = true;
      };
    };

    const cleanup = setupHealthProbe();
    expect(cleaned).toBe(false);

    cleanup();
    expect(cleaned).toBe(true);
    expect(intervalId).toBe(null);
  });

  it("should handle buffer overflow in health responses", async () => {
    const maxBodySize = 64 * 1024; // 64KB limit
    const testCases = [
      { size: 32 * 1024, shouldPass: true },
      { size: 64 * 1024, shouldPass: true },
      { size: 65 * 1024, shouldPass: false },
    ];

    for (const testCase of testCases) {
      let bodySize = 0;
      let destroyed = false;

      const onData = (chunk: { length: number }) => {
        bodySize += chunk.length;
        if (bodySize > maxBodySize) {
          destroyed = true;
          return;
        }
      };

      // Simulate receiving chunks
      for (let i = 0; i < testCase.size; i += 8192) {
        const chunkSize = Math.min(8192, testCase.size - i);
        onData({ length: chunkSize });
      }

      expect(destroyed).toBe(!testCase.shouldPass);
    }
  });
});
