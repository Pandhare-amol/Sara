import http from "http";

// ============================================================
// SARA Service Health Checks
// ============================================================

export interface HealthStatus {
  service: string;
  ok: boolean;
  latencyMs?: number;
  reason?: string;
}

/**
 * Generic HTTP health check — sends GET to url and expects HTTP 200.
 */
export async function checkHttp(service: string, url: string, timeoutMs = 3000): Promise<HealthStatus> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve({
        service,
        ok,
        latencyMs: Date.now() - start,
        reason: ok ? undefined : `HTTP ${res.statusCode}`,
      });
    });
    req.on("error", (err) => {
      resolve({ service, ok: false, latencyMs: Date.now() - start, reason: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ service, ok: false, latencyMs: Date.now() - start, reason: "Timeout" });
    });
  });
}

/**
 * Check the Node backend / frontend (same port: 3000).
 */
export async function checkBackend(port = 3000): Promise<HealthStatus> {
  return checkHttp("Backend/Frontend", `http://127.0.0.1:${port}/health`);
}

/**
 * Check the Python desktop agent.
 */
export async function checkDesktopAgent(port = 8765): Promise<HealthStatus> {
  const start = Date.now();
  const health = await checkHttp("Desktop Agent", `http://127.0.0.1:${port}/health`);
  if (!health.ok) {
    return health;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        tool: "desktopAgentDiagnostic",
        args: { request_id: "health-check", operation_id: "health-check-desktop-agent" },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { service: "Desktop Agent", ok: false, latencyMs: Date.now() - start, reason: `HTTP ${res.status}` };
    }
    const payload = await res.json().catch(() => ({}));
    const result = payload?.result ?? payload?.data?.result ?? payload;
    const verified = payload?.verified === true || result?.verification === "healthy" || result?.verification === true;
    return {
      service: "Desktop Agent",
      ok: verified,
      latencyMs: Date.now() - start,
      reason: verified ? undefined : "desktopAgentDiagnostic did not verify",
    };
  } catch (e: any) {
    return { service: "Desktop Agent", ok: false, latencyMs: Date.now() - start, reason: e.message };
  }
}

/**
 * Check the database file is present and readable.
 */
export async function checkDatabase(dbPath: string): Promise<HealthStatus> {
  const { existsSync, statSync } = await import("fs");
  try {
    if (existsSync(dbPath)) {
      statSync(dbPath); // throws if inaccessible
      return { service: "Database", ok: true };
    }
    return { service: "Database", ok: false, reason: `File not found: ${dbPath}` };
  } catch (e: any) {
    return { service: "Database", ok: false, reason: e.message };
  }
}

/**
 * Check that GEMINI_API_KEY is present (lightweight check — does not make a network call).
 */
export async function checkGemini(): Promise<HealthStatus> {
  const key = process.env.GEMINI_API_KEY;
  if (key && key.trim() && key !== "MY_GEMINI_API_KEY") {
    return { service: "Gemini API Key", ok: true };
  }
  return { service: "Gemini API Key", ok: false, reason: "GEMINI_API_KEY not configured" };
}

/**
 * Check the memory system database (sara_memory.db).
 */
export async function checkMemory(dbPath: string): Promise<HealthStatus> {
  const { existsSync } = await import("fs");
  const ok = existsSync(dbPath);
  return {
    service: "Memory System",
    ok,
    reason: ok ? undefined : `sara_memory.db not found at ${dbPath}`,
  };
}

/**
 * Run all health checks and print a status table.
 */
export async function runAllHealthChecks(config: {
  backendPort: number;
  agentPort: number;
  projectRoot: string;
}): Promise<HealthStatus[]> {
  const { join } = await import("path");

  const checks = await Promise.all([
    checkDatabase(join(config.projectRoot, "data.db")),
    checkMemory(join(config.projectRoot, "sara_memory.db")),
    checkGemini(),
    checkBackend(config.backendPort),
    checkDesktopAgent(config.agentPort),
  ]);

  return checks;
}

/**
 * Pretty-print health check results to the console.
 */
export function printHealthReport(checks: HealthStatus[]): void {
  console.log("\n[SARA] ─────── Health Report ──────────────────────────");
  const longestName = Math.max(...checks.map((c) => c.service.length));
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    const label = c.service.padEnd(longestName);
    const latency = c.latencyMs !== undefined ? ` (${c.latencyMs}ms)` : "";
    const note = c.reason ? ` — ${c.reason}` : "";
    console.log(`[SARA]   ${icon} ${label}${latency}${note}`);
  }
  const allOk = checks.every((c) => c.ok);
  console.log("[SARA] ──────────────────────────────────────────────────");
  if (allOk) {
    console.log("[SARA] ✅  All systems operational. SARA is READY.");
  } else {
    const failed = checks.filter((c) => !c.ok).map((c) => c.service);
    console.log(`[SARA] ⚠️  Degraded: ${failed.join(", ")} failed health check.`);
  }
  console.log("[SARA] ──────────────────────────────────────────────────\n");
}
