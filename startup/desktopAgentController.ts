/**
 * SARA Desktop Agent Controller
 *
 * Manages the Desktop Agent lifecycle:
 * - Automatic startup on demand
 * - Health monitoring
 * - Crash recovery with exponential backoff
 * - Capability verification
 * - Tool registry validation
 *
 * The Desktop Agent is a REQUIRED core service.
 * SARA will not mark startup as complete without it.
 *
 * Created by: Mr Amol Pandhre & the SARA Team
 */

import { spawn, execSync, ChildProcess } from "child_process";
import path from "path";
import http from "http";
import net from "net";
import fs from "fs";
import {
  ensureDesktopAgentInternalToken,
  getDesktopAgentAuthHeaders,
  hasAuthenticatedDesktopAgentProtocol,
} from "../src/security/desktopAgentAuth.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type DesktopAgentState = 
  | "STOPPED"
  | "STARTING"
  | "HEALTHY"
  | "UNHEALTHY"
  | "FAILED"
  | "RESTARTING";

export interface DesktopAgentStatus {
  state: DesktopAgentState;
  pid?: number;
  port: number;
  startedAt?: Date;
  lastHealthCheck?: Date;
  restartCount: number;
  lastError?: string;
  toolsCount?: number;
  toolsRegistered?: number;
  toolsFailed?: number;
  criticalToolsPresent: boolean;
  capabilities?: string[];
  pythonPath?: string;
  pythonVersion?: string;
}

interface HealthResponse {
  status: string;
  service?: string;
  agent_auth_required?: boolean;
  agent_auth_protocol_version?: number;
  tools?: string[];
  tool_count?: number;
  registered?: number;
  failed?: number;
  capabilities?: string[];
  python_version?: string;
  errors?: string[];
}

// ─────────────────────────────────────────────────────────────────
// Critical Tools — Desktop Agent must have these
// ─────────────────────────────────────────────────────────────────

const CRITICAL_TOOLS = [
  "hardwareMouseMove",
  "hardwareMouseClick",
  "hardwareKeyboardType",
  "hardwareKeyboardPress",
  "takeScreenshot",
  "readScreen",
  "openApplication",
  "openWebsite",
  "desktopAgentDiagnostic",
];

// ─────────────────────────────────────────────────────────────────
// Desktop Agent Controller
// ─────────────────────────────────────────────────────────────────

export class DesktopAgentController {
  private port: number;
  private pythonExePath: string;
  private projectRoot: string;
  private agentDir: string;
  private status: DesktopAgentStatus;
  private process: ChildProcess | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private maxRestarts = 6;

  constructor(
    port: number = 8765,
    pythonExePath: string = "python.exe",
    projectRoot: string = process.cwd()
  ) {
    this.port = port;
    this.pythonExePath = pythonExePath;
    this.projectRoot = projectRoot;
    ensureDesktopAgentInternalToken(process.env);
    this.agentDir = path.join(projectRoot, "desktop_agent");

    this.status = {
      state: "STOPPED",
      port,
      restartCount: 0,
      criticalToolsPresent: false,
    };
  }

  /**
   * Get current Desktop Agent status
   */
  getStatus(): DesktopAgentStatus {
    return { ...this.status };
  }

  /**
   * Check if Desktop Agent is currently healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.getHealthData();
      return response !== null;
    } catch {
      return false;
    }
  }

  /** Read health and prove the shared token through a protected endpoint. */
  private async requestJson(url: string, headers?: Record<string, string>): Promise<any | null> {
    return new Promise((resolve) => {
      let settled = false;
      let body = "";
      const finish = (value: any | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = http.get(url, { headers, timeout: 5000 }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            req.destroy();
            finish(null);
          }
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return finish(null);
          try { finish(JSON.parse(body)); } catch { finish(null); }
        });
        res.on("error", () => finish(null));
      });
      req.on("error", () => finish(null));
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
    });
  }

  private async getHealthData(): Promise<HealthResponse | null> {
    try {
      const baseUrl = `http://127.0.0.1:${this.port}`;
      const headers = getDesktopAgentAuthHeaders(baseUrl, process.env);
      const health = await this.requestJson(`${baseUrl}/health`, headers) as HealthResponse | null;
      if (health?.service !== "sara-desktop-agent" || !hasAuthenticatedDesktopAgentProtocol(health)) return null;
      const auth = await this.requestJson(`${baseUrl}/auth/check`, headers);
      if (auth?.service !== "sara-desktop-agent" || !hasAuthenticatedDesktopAgentProtocol(auth)) return null;
      return health;
    } catch {
      return null;
    }
  }

  /** Verify the authenticated agent exposes the controller's required tools. */
  async verifyCapabilities(): Promise<boolean> {
    try {
      const health = await this.getHealthData();
      if (!health) {
        this.status.lastError = "Authenticated agent health check did not verify";
        return false;
      }

      const tools = Array.isArray(health.tools) ? health.tools : [];
      const toolsCount = Number(health.tool_count ?? tools.length);
      const missing = CRITICAL_TOOLS.filter((tool) => !tools.includes(tool));
      this.status.toolsCount = toolsCount;
      this.status.toolsRegistered = Number(health.registered ?? toolsCount);
      this.status.toolsFailed = Number.isFinite(health.failed) ? Number(health.failed) : undefined;
      this.status.capabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
      this.status.pythonVersion = health.python_version;
      this.status.criticalToolsPresent = toolsCount > 0 && missing.length === 0;

      if (!toolsCount) {
        this.status.lastError = "No tools were reported by the authenticated agent health response";
        return false;
      }
      if (missing.length > 0) {
        this.status.lastError = `Missing critical tools: ${missing.join(", ")}`;
        return false;
      }
      if ((this.status.toolsFailed || 0) > 0) {
        this.status.lastError = `${this.status.toolsFailed} tool registration(s) failed`;
        return false;
      }

      this.status.lastError = undefined;
      return true;
    } catch (e) {
      this.status.lastError = `Capability check failed: ${e}`;
      return false;
    }
  }

  /** Start or adopt the agent only after authenticated protocol verification. */
  async start(): Promise<boolean> {
    console.log("[DesktopAgent] Starting...");
    this.status.state = "STARTING";

    const existing = await this.getHealthData();
    if (existing) {
      const verified = await this.verifyCapabilities();
      if (verified) {
        this.status.state = "HEALTHY";
        console.log("[DesktopAgent] Adopted an authenticated agent channel.");
        this.startHealthMonitoring();
        return true;
      }
      this.status.state = "UNHEALTHY";
      return false;
    }
    if (await this.isPortOccupied()) {
      this.status.state = "FAILED";
      this.status.lastError = "Agent port is occupied by a listener that failed authentication; it was left untouched.";
      console.warn(`[DesktopAgent] ${this.status.lastError}`);
      return false;
    }

    if (!this.pythonExePath) this.pythonExePath = "python.exe";
    try {
      execSync(`where ${this.pythonExePath}`, { stdio: "ignore" });
    } catch {
      this.status.state = "FAILED";
      this.status.lastError = `Python not found: ${this.pythonExePath}`;
      console.error(`[DesktopAgent] ${this.status.lastError}`);
      return false;
    }

    if (!fs.existsSync(this.agentDir)) {
      this.status.state = "FAILED";
      this.status.lastError = `Agent directory not found: ${this.agentDir}`;
      console.error(`[DesktopAgent] ${this.status.lastError}`);
      return false;
    }

    try {
      this.process = spawn(this.pythonExePath, ["-m", "uvicorn", "desktop_agent.main:app", "--port", String(this.port), "--host", "127.0.0.1"], {
        cwd: this.projectRoot,
        stdio: "inherit",
        shell: false,
        env: {
          ...process.env,
          SARA_AGENT_INTERNAL_TOKEN: process.env.SARA_AGENT_INTERNAL_TOKEN,
          SARA_AGENT_PORT: String(this.port),
        },
      });

      this.status.pid = this.process.pid;
      this.status.startedAt = new Date();
      this.process.on("exit", (code) => {
        this.status.lastExitCode = code;
        this.handleCrash();
      });
      this.process.on("error", (err) => {
        this.status.lastError = err.message;
        this.handleCrash();
      });

      const healthy = await this.waitForHealth(30000);
      if (!healthy) {
        this.status.state = "FAILED";
        this.status.lastError = "Authenticated health handshake timed out";
        console.error(`[DesktopAgent] ${this.status.lastError}`);
        return false;
      }

      const verified = await this.verifyCapabilities();
      if (!verified) {
        this.status.state = "UNHEALTHY";
        console.warn("[DesktopAgent] Started but critical tool verification failed");
        this.startHealthMonitoring();
        return false;
      }

      this.status.state = "HEALTHY";
      console.log(`[DesktopAgent] Started successfully (PID ${this.status.pid})`);
      this.startHealthMonitoring();
      return true;
    } catch (e) {
      this.status.state = "FAILED";
      this.status.lastError = String(e);
      console.error(`[DesktopAgent] Failed to start: ${e}`);
      return false;
    }
  }

  /**
   * Wait for Desktop Agent to become healthy
   */
  private async waitForHealth(maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const health = await this.getHealthData();
      if (health) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Start continuous health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(async () => {
      const health = await this.getHealthData();
      this.status.lastHealthCheck = new Date();

      if (health) {
        const verified = await this.verifyCapabilities();
        if (verified && this.status.state !== "HEALTHY") {
          this.status.state = "HEALTHY";
          this.status.lastError = undefined;
          console.log("[DesktopAgent] Recovered to HEALTHY");
        } else if (!verified && this.status.state === "HEALTHY") {
          this.status.state = "UNHEALTHY";
          console.warn("[DesktopAgent] Critical tool verification failed");
        }
      } else if (this.status.state === "HEALTHY") {
        this.status.state = "UNHEALTHY";
        this.status.lastError = "Authenticated health check failed";
        console.warn("[DesktopAgent] Degraded to UNHEALTHY");
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Handle Desktop Agent crash and attempt recovery
   */
  private async handleCrash(): Promise<void> {
    console.warn(
      `[DesktopAgent] Process exited (restart count: ${this.status.restartCount}/${this.maxRestarts})`
    );

    if (this.status.restartCount >= this.maxRestarts) {
      this.status.state = "FAILED";
      console.error(
        `[DesktopAgent] Exceeded max restarts (${this.maxRestarts})`
      );
      return;
    }

    this.status.state = "RESTARTING";

    // Exponential backoff: 1s, 2s, 4s, 8s, 15s, 30s
    const delayMs = Math.min(1000 * Math.pow(2, this.status.restartCount), 30000);
    console.log(
      `[DesktopAgent] Will restart in ${delayMs}ms (attempt ${this.status.restartCount + 1}/${this.maxRestarts})`
    );

    await new Promise((r) => setTimeout(r, delayMs));

    this.status.restartCount += 1;
    await this.start();
  }

  /**
   * Stop the Desktop Agent
   */
  async stop(): Promise<void> {
    console.log("[DesktopAgent] Stopping...");
    this.status.state = "STOPPED";

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2000));

      if (!this.process.killed) {
        this.process.kill("SIGKILL");
      }
    }

    this.process = null;
  }

  /**
   * Restart the Desktop Agent
   */
  async restart(): Promise<boolean> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 2000));
    this.status.restartCount = 0;
    return this.start();
  }

  /** Never terminate an unverified listener; only report whether the port is occupied. */
  private isPortOccupied(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      let settled = false;
      const finish = (occupied: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(occupied);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
  }

  /**
   * Get diagnostic report
   */
  getDiagnosticReport(): {
    timestamp: Date;
    status: DesktopAgentStatus;
    isReady: boolean;
    summary: string;
  } {
    const isReady =
      this.status.state === "HEALTHY" &&
      this.status.criticalToolsPresent &&
      (this.status.toolsFailed || 0) === 0;

    let summary = "Desktop Agent status unknown";
    if (this.status.state === "HEALTHY" && isReady) {
      summary = `Desktop Agent READY (${this.status.toolsCount} tools)`;
    } else if (this.status.state === "HEALTHY") {
      summary = `Desktop Agent partially ready: ${this.status.lastError}`;
    } else if (this.status.state === "UNHEALTHY") {
      summary = `Desktop Agent unhealthy: ${this.status.lastError}`;
    } else if (this.status.state === "FAILED") {
      summary = `Desktop Agent FAILED: ${this.status.lastError}`;
    } else if (this.status.state === "RESTARTING") {
      summary = `Desktop Agent restarting (attempt ${this.status.restartCount}/${this.maxRestarts})`;
    } else {
      summary = `Desktop Agent ${this.status.state}`;
    }

    return {
      timestamp: new Date(),
      status: this.getStatus(),
      isReady,
      summary,
    };
  }
}

export default DesktopAgentController;
