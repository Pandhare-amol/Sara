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
import fs from "fs";

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
  tools_count?: number;
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

const EXPECTED_CAPABILITIES = [
  "python_runtime",
  "fastapi_running",
  "tool_registry_loaded",
  "os_input_available",
  "screenshot_available",
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

  /**
   * Fetch health data from Desktop Agent
   */
  private async getHealthData(): Promise<HealthResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        req.destroy();
        resolve(null);
      }, 5000);

      const req = http.get(
        `http://127.0.0.1:${this.port}/health`,
        { timeout: 5000 },
        (res) => {
          clearTimeout(timeout);
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(body) as HealthResponse;
                resolve(data);
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });
        }
      );

      req.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });

      req.on("timeout", () => {
        clearTimeout(timeout);
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Verify Desktop Agent capabilities and tool registry
   */
  async verifyCapabilities(): Promise<boolean> {
    try {
      const health = await this.getHealthData();
      if (!health) {
        this.status.lastError = "Health endpoint not responding";
        return false;
      }

      // Check tool count
      const toolsCount = health.tools_count || 0;
      const registered = health.registered || 0;
      const failed = health.failed || 0;

      this.status.toolsCount = toolsCount;
      this.status.toolsRegistered = registered;
      this.status.toolsFailed = failed;

      if (toolsCount === 0) {
        this.status.lastError = "No tools loaded";
        return false;
      }

      if (failed > 0) {
        this.status.lastError = `${failed} tool registration(s) failed`;
        return false;
      }

      // Check capabilities
      const caps = health.capabilities || [];
      const hasCriticalCaps = EXPECTED_CAPABILITIES.every((cap) =>
        caps.includes(cap)
      );

      if (!hasCriticalCaps) {
        const missing = EXPECTED_CAPABILITIES.filter(
          (cap) => !caps.includes(cap)
        );
        this.status.lastError = `Missing capabilities: ${missing.join(", ")}`;
        return false;
      }

      this.status.capabilities = caps;
      this.status.pythonVersion = health.python_version;
      this.status.criticalToolsPresent = true;

      // Check for critical tools (may not always be queryable)
      // This is a heuristic check based on tool count
      if (toolsCount >= CRITICAL_TOOLS.length) {
        this.status.lastError = undefined;
        return true;
      } else {
        this.status.lastError = `Insufficient tools: have ${toolsCount}, need at least ${CRITICAL_TOOLS.length}`;
        return false;
      }
    } catch (e) {
      this.status.lastError = `Capability check failed: ${e}`;
      return false;
    }
  }

  /**
   * Start the Desktop Agent
   */
  async start(): Promise<boolean> {
    console.log("[DesktopAgent] Starting...");
    this.status.state = "STARTING";

    // Check if Python is available
    if (!this.pythonExePath) {
      this.pythonExePath = "python.exe";
    }

    try {
      execSync(`where ${this.pythonExePath}`, { stdio: "ignore" });
    } catch {
      this.status.state = "FAILED";
      this.status.lastError = `Python not found: ${this.pythonExePath}`;
      console.error(`[DesktopAgent] ${this.status.lastError}`);
      return false;
    }

    // Check if agent directory exists
    if (!fs.existsSync(this.agentDir)) {
      this.status.state = "FAILED";
      this.status.lastError = `Agent directory not found: ${this.agentDir}`;
      console.error(`[DesktopAgent] ${this.status.lastError}`);
      return false;
    }

    // Kill any existing process on port
    this.killExistingProcess();

    // Spawn the agent
    try {
      this.process = spawn(this.pythonExePath, ["-m", "uvicorn", "desktop_agent.main:app", `--port`, String(this.port), "--host", "127.0.0.1"], {
        cwd: this.projectRoot,
        stdio: "inherit",
        shell: false,
      });

      this.status.pid = this.process.pid;
      this.status.startedAt = new Date();

      // Handle process events
      this.process.on("exit", (code) => {
        this.status.lastExitCode = code;
        this.handleCrash();
      });

      this.process.on("error", (err) => {
        this.status.lastError = err.message;
        this.handleCrash();
      });

      // Wait for health
      const healthy = await this.waitForHealth(30000);

      if (healthy) {
        // Verify capabilities
        const verified = await this.verifyCapabilities();
        if (verified) {
          this.status.state = "HEALTHY";
          console.log(`[DesktopAgent] Started successfully (PID ${this.status.pid})`);
          this.startHealthMonitoring();
          return true;
        } else {
          this.status.state = "UNHEALTHY";
          console.warn(`[DesktopAgent] Started but capabilities check failed`);
          this.startHealthMonitoring(); // Still monitor
          return false;
        }
      } else {
        this.status.state = "FAILED";
        this.status.lastError = "Health check timeout";
        console.error(`[DesktopAgent] Health check timeout`);
        return false;
      }
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
        // Update tool info
        this.status.toolsCount = health.tools_count;
        this.status.toolsRegistered = health.registered;
        this.status.toolsFailed = health.failed;

        // Check if still healthy
        if (this.status.state !== "HEALTHY" && this.status.toolsFailed === 0) {
          this.status.state = "HEALTHY";
          this.status.lastError = undefined;
          console.log("[DesktopAgent] Recovered to HEALTHY");
        }
      } else {
        if (this.status.state === "HEALTHY") {
          this.status.state = "UNHEALTHY";
          this.status.lastError = "Health check failed";
          console.warn("[DesktopAgent] Degraded to UNHEALTHY");
        }
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

  /**
   * Kill any existing process on the Desktop Agent port
   */
  private killExistingProcess(): void {
    try {
      const output = execSync(`netstat -ano -p TCP`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();

      for (const line of output.split("\n")) {
        const match = line.match(/:(\d+)\s+\S+\s+LISTEN\s+(\d+)/);
        if (match && parseInt(match[1], 10) === this.port) {
          const pid = parseInt(match[2], 10);
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
            console.log(`[DesktopAgent] Killed existing process PID ${pid}`);
          } catch {}
        }
      }
    } catch {}
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
