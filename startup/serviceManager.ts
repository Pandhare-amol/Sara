/**
 * SARA Service Manager
 *
 * Centralized management of SARA services:
 * - Backend (Node.js/Express)
 * - Desktop Agent (Python/FastAPI)
 * - Electron UI
 *
 * Handles:
 * - Service lifecycle (start, stop, restart)
 * - Health monitoring
 * - Crash recovery with exponential backoff
 * - Process ownership verification
 * - Port management
 * - Service state tracking
 *
 * Created by: Mr Amol Pandhre & the SARA Team
 */

import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";

// ─────────────────────────────────────────────────────────────────
// Types & Interfaces
// ─────────────────────────────────────────────────────────────────

export type ServiceState = 
  | "STOPPED"
  | "STARTING"
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "FAILED"
  | "RESTARTING"
  | "STOPPING";

export interface ServiceInfo {
  name: string;
  pid?: number;
  port?: number;
  state: ServiceState;
  startedAt?: Date;
  lastHealthCheck?: Date;
  lastError?: string;
  restartCount: number;
  lastExitCode?: number;
  processOwnershipVerified: boolean;
  capabilities?: string[];
  version?: string;
}

export interface ServiceConfig {
  name: string;
  port: number;
  healthPath: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  healthCheckInterval: number;
  maxRestarts: number;
  backoffStrategy: "exponential" | "linear" | "none";
  requiredCapabilities?: string[];
}

// ─────────────────────────────────────────────────────────────────
// Service Manager
// ─────────────────────────────────────────────────────────────────

export class ServiceManager {
  private services = new Map<string, ServiceInfo>();
  private processes = new Map<string, ChildProcess>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  private restartBackoff = new Map<string, number>();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Get current service info
   */
  getServiceInfo(serviceName: string): ServiceInfo | null {
    return this.services.get(serviceName) || null;
  }

  /**
   * Get all services
   */
  getAllServices(): ServiceInfo[] {
    return Array.from(this.services.values());
  }

  /**
   * Get overall system health (HEALTHY, DEGRADED, FAILED)
   */
  getSystemHealth(): "HEALTHY" | "DEGRADED" | "FAILED" {
    const services = this.getAllServices();
    if (services.length === 0) return "HEALTHY";

    const healthy = services.filter((s) => s.state === "HEALTHY").length;
    const critical = services.filter((s) => s.name === "Backend" || s.name === "Desktop Agent");
    const criticalHealthy = critical.filter((s) => s.state === "HEALTHY").length;

    if (criticalHealthy === critical.length) return "HEALTHY";
    if (criticalHealthy > 0) return "DEGRADED";
    return "FAILED";
  }

  /**
   * Verify port ownership using Windows process lookup
   */
  private verifyPortOwnership(port: number, expectedCommand: string): {
    owned: boolean;
    pid?: number;
  } {
    try {
      const output = execSync(`netstat -ano -p TCP`, {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();

      for (const line of output.split("\n")) {
        const match = line.match(/:(\d+)\s+\S+\s+LISTEN\s+(\d+)/);
        if (match && parseInt(match[1], 10) === port) {
          const pid = parseInt(match[2], 10);

          // Verify the process command matches expected pattern
          try {
            const procCmd = execSync(
              `wmic process where ProcessId=${pid} get CommandLine /format:value`,
              { stdio: ["ignore", "pipe", "ignore"] }
            )
              .toString()
              .trim();

            const isMatch =
              procCmd.includes(expectedCommand) ||
              procCmd.includes("sara") ||
              procCmd.includes("desktop_agent");

            return { owned: isMatch, pid };
          } catch {
            return { owned: false, pid };
          }
        }
      }
    } catch (e) {
      console.error(`[ServiceManager] Failed to verify port ownership: ${e}`);
    }

    return { owned: false };
  }

  /**
   * Check if a service is responding on its health endpoint
   */
  private async checkHealth(config: ServiceConfig): Promise<{
    healthy: boolean;
    responseTime: number;
    data?: any;
  }> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        req.destroy();
        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
        });
      }, 5000);

      const req = http.get(
        `http://127.0.0.1:${config.port}${config.healthPath}`,
        { timeout: 5000 },
        (res) => {
          clearTimeout(timeout);
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            const responseTime = Date.now() - startTime;
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(body);
                resolve({ healthy: true, responseTime, data });
              } catch {
                resolve({ healthy: true, responseTime });
              }
            } else {
              resolve({ healthy: false, responseTime });
            }
          });
        }
      );

      req.on("error", () => {
        clearTimeout(timeout);
        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
        });
      });

      req.on("timeout", () => {
        clearTimeout(timeout);
        req.destroy();
        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Start a service with proper lifecycle management
   */
  async startService(
    config: ServiceConfig,
    verify: () => Promise<{ capabilities?: string[] }> = async () => ({})
  ): Promise<ServiceInfo> {
    const existing = this.services.get(config.name);

    if (existing && existing.state === "HEALTHY") {
      console.log(`[ServiceManager] ${config.name} already healthy on PID ${existing.pid}`);
      return existing;
    }

    // Update state
    const info: ServiceInfo = {
      name: config.name,
      state: "STARTING",
      startedAt: new Date(),
      restartCount: existing?.restartCount || 0,
      processOwnershipVerified: false,
    };
    this.services.set(config.name, info);

    // Spawn process
    console.log(`[ServiceManager] Starting ${config.name}...`);
    const process = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: "inherit",
    });

    this.processes.set(config.name, process);
    info.pid = process.pid;

    // Handle process exit
    process.on("exit", (code) => {
      info.lastExitCode = code;
      this.handleServiceCrash(config, code);
    });

    process.on("error", (err) => {
      info.lastError = err.message;
      this.handleServiceCrash(config, 1);
    });

    // Wait for health
    const healthChecks = 30;
    for (let i = 0; i < healthChecks; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      const health = await this.checkHealth(config);
      if (health.healthy) {
        // Verify port ownership
        const ownership = this.verifyPortOwnership(
          config.port,
          config.command
        );

        if (ownership.owned) {
          info.state = "HEALTHY";
          info.lastHealthCheck = new Date();
          info.processOwnershipVerified = true;

          // Run custom verification
          try {
            const vResult = await verify();
            if (vResult.capabilities) {
              info.capabilities = vResult.capabilities;
            }
          } catch (e) {
            console.warn(
              `[ServiceManager] ${config.name} verification failed: ${e}`
            );
            info.state = "DEGRADED";
          }

          // Start health monitoring
          this.startHealthMonitoring(config);

          console.log(
            `[ServiceManager] ${config.name} started (PID ${info.pid})`
          );
          this.services.set(config.name, info);
          return info;
        } else {
          info.lastError = `Port ${config.port} not owned by expected process`;
          info.state = "UNHEALTHY";
        }
      }
    }

    info.state = "FAILED";
    info.lastError = "Health check timeout";
    this.services.set(config.name, info);
    return info;
  }

  /**
   * Handle service crash and attempt recovery
   */
  private async handleServiceCrash(
    config: ServiceConfig,
    exitCode: number
  ): Promise<void> {
    const info = this.services.get(config.name);
    if (!info) return;

    info.state = "FAILED";
    info.lastError = `Process exited with code ${exitCode}`;

    const currentCount = info.restartCount;
    if (currentCount >= config.maxRestarts) {
      console.error(
        `[ServiceManager] ${config.name} exceeded max restarts (${config.maxRestarts})`
      );
      return;
    }

    // Calculate backoff
    let delayMs = 1000;
    if (config.backoffStrategy === "exponential") {
      delayMs = Math.min(1000 * Math.pow(2, currentCount), 30000);
    } else if (config.backoffStrategy === "linear") {
      delayMs = 1000 * (currentCount + 1);
    }

    console.log(
      `[ServiceManager] ${config.name} will restart in ${delayMs}ms (attempt ${currentCount + 1}/${config.maxRestarts})`
    );

    info.state = "RESTARTING";
    this.services.set(config.name, info);

    await new Promise((r) => setTimeout(r, delayMs));

    info.restartCount = currentCount + 1;
    this.startService(config);
  }

  /**
   * Start continuous health monitoring
   */
  private startHealthMonitoring(config: ServiceConfig): void {
    // Clear existing interval
    const existing = this.healthCheckIntervals.get(config.name);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      const info = this.services.get(config.name);
      if (!info) return;

      const health = await this.checkHealth(config);
      info.lastHealthCheck = new Date();

      if (health.healthy) {
        if (info.state !== "HEALTHY") {
          info.state = "HEALTHY";
          console.log(`[ServiceManager] ${config.name} recovered to HEALTHY`);
        }
      } else {
        if (info.state === "HEALTHY") {
          info.state = "DEGRADED";
          console.warn(
            `[ServiceManager] ${config.name} degraded (response time: ${health.responseTime}ms)`
          );
        }
      }
    }, config.healthCheckInterval);

    this.healthCheckIntervals.set(config.name, interval);
  }

  /**
   * Stop a service
   */
  async stopService(serviceName: string): Promise<void> {
    const info = this.services.get(serviceName);
    if (!info) return;

    info.state = "STOPPING";

    const process = this.processes.get(serviceName);
    if (process && !process.killed) {
      process.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2000));

      if (!process.killed) {
        process.kill("SIGKILL");
      }
    }

    // Clear health check
    const interval = this.healthCheckIntervals.get(serviceName);
    if (interval) clearInterval(interval);

    info.state = "STOPPED";
  }

  /**
   * Restart a service
   */
  async restartService(
    config: ServiceConfig,
    verify?: () => Promise<{ capabilities?: string[] }>
  ): Promise<ServiceInfo> {
    await this.stopService(config.name);
    await new Promise((r) => setTimeout(r, 2000));
    return this.startService(config, verify);
  }

  /**
   * Get detailed diagnostic report
   */
  getDiagnosticReport(): {
    timestamp: Date;
    overallHealth: "HEALTHY" | "DEGRADED" | "FAILED";
    services: ServiceInfo[];
    summary: string;
  } {
    const services = this.getAllServices();
    const overallHealth = this.getSystemHealth();

    let summary = "All systems operational";
    const unhealthy = services.filter((s) => s.state !== "HEALTHY");
    if (unhealthy.length > 0) {
      summary = `${unhealthy.length} service(s) not healthy: ${unhealthy
        .map((s) => `${s.name}(${s.state})`)
        .join(", ")}`;
    }

    return {
      timestamp: new Date(),
      overallHealth,
      services,
      summary,
    };
  }
}

export default ServiceManager;
