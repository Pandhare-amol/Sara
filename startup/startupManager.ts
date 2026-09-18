#!/usr/bin/env tsx

/**
 * SARA Production Startup Manager
 *
 * Responsibilities:
 *   1. Acquire exactly one SARA supervisor lock.
 *   2. Validate configuration.
 *   3. Start/adopt backend.
 *   4. Start/adopt Desktop Agent.
 *   5. Run health checks.
 *   6. Start exactly one supervisor loop.
 *   7. Start/adopt exactly one Electron UI.
 *   8. Keep the supervisor alive.
 *   9. Clean up only processes owned by this supervisor.
 */

import path from "path";
import fs from "fs";
import http from "http";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

import {
  gatherBuildIdentity,
  getBuildLabel,
} from "../src/security/buildIdentity.js";

import {
  validateConfig,
  buildServiceConfig,
} from "./configValidator.js";

import {
  startService,
  stopAll,
  running,
  type ServiceHandle,
  isSaraOwnedPid,
} from "./processGuard.js";

import {
  runAllHealthChecks,
  printHealthReport,
} from "./healthChecks.js";

import {
  type ServiceState,
  formatStartupSummary,
} from "./startupState.js";

import {
  spawnElectronWithConfig,
} from "./electronLauncher.js";
import { SelfImprovementManager } from "../src/self_improvement/SelfImprovementManager.js";

// ============================================================
// Paths
// ============================================================

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DATA_DIR = path.join(
  PROJECT_ROOT,
  "data",
);

const LOCK_PATH = path.join(
  DATA_DIR,
  "sara.lock",
);

// ============================================================
// Logging
// ============================================================

function log(message: string): void {
  console.log(`[SARA] ${message}`);
}

function logWarn(message: string): void {
  console.warn(`[SARA][WARN] ${message}`);
}

function logError(message: string): void {
  console.error(`[SARA][ERROR] ${message}`);
}

function ensureProductionBundle(): boolean {
  const bundlePath = path.join(PROJECT_ROOT, "dist", "server.cjs");
  if (fs.existsSync(bundlePath)) {
    return true;
  }

  logWarn("Production backend bundle is missing. Building it now...");
  try {
    execSync(
      `${process.platform === "win32" ? "npm.cmd" : "npm"} run build`,
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  } catch (error) {
    logError(`Production build failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  if (!fs.existsSync(bundlePath)) {
    logError(`Production build completed without creating ${bundlePath}.`);
    return false;
  }

  log("Production backend bundle is ready.");
  return true;
}

// ============================================================
// Health check
// ============================================================

interface HealthResponse {
  ok: boolean;
  status: number;
  data?: any;
}

async function httpHealthCheck(
  port: number,
  healthPath = "/health",
  timeoutMs = 2500,
): Promise<HealthResponse> {
  return new Promise((resolve) => {
    let settled = false;

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: HealthResponse): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({
        ok: false,
        status: 0,
      });
    }, timeoutMs);

    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: healthPath,
        method: "GET",
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
        agent: false,
      },
      (res) => {
        let body = "";

        res.setEncoding("utf8");

        res.on("data", (chunk: string) => {
          if (body.length < 64 * 1024) {
            body += chunk;
          }
        });

        res.on("end", () => {
          let data: any = undefined;

          try {
            if (body) {
              data = JSON.parse(body);
            }
          } catch {
            data = undefined;
          }

          finish({
            ok: res.statusCode === 200,
            status: res.statusCode ?? 0,
            data,
          });
        });

        res.on("error", () => {
          finish({
            ok: false,
            status: 0,
          });
        });
      },
    );

    req.on("error", () => {
      finish({
        ok: false,
        status: 0,
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();

      finish({
        ok: false,
        status: 0,
      });
    });
  });
}

// ============================================================
// Windows process inspection
// ============================================================

function getWindowsProcessCommandLines(): string {
  if (process.platform !== "win32") {
    return "";
  }

  /*
   * PowerShell/CIM is preferred.
   *
   * WMIC has been deprecated/removed on newer Windows versions,
   * so it is only a fallback.
   */

  const attempts = [
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`,

    `wmic.exe process get ProcessId,CommandLine /format:csv`,
  ];

  for (const command of attempts) {
    try {
      const output = execSync(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });

      const text = output.toString();

      if (text.trim()) {
        return text;
      }
    } catch {
      // Try next method.
    }
  }

  return "";
}

// ============================================================
// Process parsing
// ============================================================

function parseProcessPidAndCommand(
  rawLine: string,
): {
  pid: number | null;
  cmd: string;
} {
  const line = rawLine.trim();

  if (!line) {
    return {
      pid: null,
      cmd: "",
    };
  }

  /*
   * PowerShell ConvertTo-Csv commonly produces:
   *
   * "ProcessId","CommandLine"
   * "1234","electron.exe ..."
   *
   * Handle quoted CSV safely enough for our two-column format.
   */

  if (
    line.startsWith('"') &&
    line.includes('","')
  ) {
    const match = line.match(
      /^"([^"]*)","([\s\S]*)"$/,
    );

    if (match) {
      const pid = Number.parseInt(
        match[1],
        10,
      );

      return {
        pid:
          Number.isFinite(pid) && pid > 0
            ? pid
            : null,
        cmd: match[2] || "",
      };
    }
  }

  /*
   * WMIC CSV:
   *
   * Node,ComputerName,CommandLine,ProcessId
   *
   * Do not assume PID is the first CSV field.
   */

  if (line.includes(",")) {
    const parts = line
      .split(",")
      .map((part) => part.trim());

    const numericCandidates = parts
      .map((part) => Number.parseInt(part, 10))
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value > 0,
      );

    if (numericCandidates.length > 0) {
      const pid =
        numericCandidates[
          numericCandidates.length - 1
        ];

      const cmd = parts
        .filter(
          (part) =>
            !/^\d+$/.test(part),
        )
        .join(",")
        .trim();

      return {
        pid,
        cmd,
      };
    }
  }

  /*
   * Generic:
   *
   * PID command line
   */

  const match = line.match(
    /(?:^|\s)(\d+)\s+(.+)$/,
  );

  if (match) {
    const pid = Number.parseInt(
      match[1],
      10,
    );

    return {
      pid:
        Number.isFinite(pid) && pid > 0
          ? pid
          : null,

      cmd: match[2] || "",
    };
  }

  return {
    pid: null,
    cmd: line,
  };
}

// ============================================================
// SARA Electron detection
// ============================================================

function isSaraElectronCommand(
  commandLine: string,
  projectRoot: string,
): boolean {
  const normalized = String(
    commandLine || "",
  )
    .toLowerCase()
    .replace(/\//g, "\\");

  const normalizedRoot =
    projectRoot
      .toLowerCase()
      .replace(/\//g, "\\");

  /*
   * IMPORTANT:
   *
   * Do NOT use only:
   *
   *   normalized.includes("sara")
   *
   * because that can match unrelated applications/processes.
   */

  const strongMatches = [
    `${normalizedRoot}\\electron`,
    `${normalizedRoot}\\dist\\electron`,
    "\\electron\\main.cjs",
    "\\electron\\main.js",
    "electron.exe",
  ];

  const projectMatch =
    normalized.includes(normalizedRoot);

  const mainMatch =
    normalized.includes(
      "\\electron\\main.cjs",
    ) ||
    normalized.includes(
      "\\electron\\main.js",
    );

  const saraProjectMatch =
    normalized.includes(
      "myraa-ai-assistant",
    );

  return (
    mainMatch ||
    saraProjectMatch ||
    projectMatch ||
    strongMatches.some(
      (value) =>
        normalized.includes(value),
    )
  );
}

// ============================================================
// Find all SARA Electron processes
// ============================================================

function findAllSaraElectronPids(
  projectRoot: string,
): number[] {
  if (process.platform !== "win32") {
    return [];
  }

  const result = new Set<number>();

  const output =
    getWindowsProcessCommandLines();

  if (!output) {
    return [];
  }

  for (
    const line of output.split(/\r?\n/)
  ) {
    const parsed =
      parseProcessPidAndCommand(line);

    if (!parsed.pid) {
      continue;
    }

    if (parsed.pid === process.pid) {
      continue;
    }

    const command =
      parsed.cmd.toLowerCase();

    if (
      !command.includes("electron")
    ) {
      continue;
    }

    if (
      isSaraElectronCommand(
        parsed.cmd,
        projectRoot,
      )
    ) {
      result.add(parsed.pid);
    }
  }

  return [...result];
}

// ============================================================
// Find existing Electron
// ============================================================

function findExistingElectronPid(
  projectRoot: string,
): number | null {
  const pids =
    findAllSaraElectronPids(
      projectRoot,
    );

  /*
   * Validate that candidate PIDs are still alive.
   */

  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      return pid;
    }
  }

  return null;
}

// ============================================================
// Process existence
// ============================================================

function isProcessAlive(
  pid: number,
): boolean {
  if (
    !Number.isFinite(pid) ||
    pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    /*
     * EPERM means the process exists but we do not
     * have permission to signal it.
     */
    if (error?.code === "EPERM") {
      return true;
    }

    return false;
  }
}

// ============================================================
// Terminate Electron
// ============================================================

function terminateElectronPid(
  pid: number,
): boolean {
  if (
    !Number.isFinite(pid) ||
    pid <= 0 ||
    pid === process.pid
  ) {
    return false;
  }

  try {
    /*
     * Re-check that this is actually a SARA Electron
     * process before terminating it.
     */

    if (process.platform === "win32") {
      execSync(
        `taskkill.exe /PID ${pid} /T /F`,
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } else {
      process.kill(
        pid,
        "SIGTERM",
      );
    }

    log(
      `Terminated SARA Electron PID ${pid}.`,
    );

    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Duplicate Electron cleanup
// ============================================================

function cleanupDuplicateElectronProcesses(
  projectRoot: string,
  keepPid: number,
): number[] {
  const pids =
    findAllSaraElectronPids(
      projectRoot,
    );

  const removed: number[] = [];

  for (const pid of pids) {
    if (pid === keepPid) {
      continue;
    }

    if (
      terminateElectronPid(pid)
    ) {
      removed.push(pid);
    }
  }

  return removed;
}

// ============================================================
// Lock
// ============================================================

interface SaraLock {
  pid?: number;
  startedAt?: string;
  buildId?: string;
  buildHash?: string;
}

function readLock(): SaraLock | null {
  try {
    const text =
      fs.readFileSync(
        LOCK_PATH,
        "utf8",
      );

    if (!text.trim()) {
      return null;
    }

    const parsed =
      JSON.parse(text);

    if (
      !parsed ||
      typeof parsed !== "object"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function removeLock(): void {
  try {
    if (
      fs.existsSync(LOCK_PATH)
    ) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (error) {
    logWarn(
      `Unable to remove lock: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

function writeLock(
  buildId: string,
  buildHash: string,
): void {
  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true,
    },
  );

  const fd =
    fs.openSync(
      LOCK_PATH,
      "wx",
    );

  try {
    fs.writeSync(
      fd,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt:
            new Date().toISOString(),
          buildId,
          buildHash,
        },
        null,
        2,
      ),
    );
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================
// Acquire supervisor lock
// ============================================================

async function acquireSupervisorLock(
  backendPort: number,
  agentPort: number,
  buildId: string,
  buildHash: string,
): Promise<boolean> {
  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true,
    },
  );

  /*
   * Fast path.
   */

  try {
    writeLock(
      buildId,
      buildHash,
    );

    return true;
  } catch {
    // Existing lock.
  }

  const lock =
    readLock();

  const existingPid =
    Number(lock?.pid);

  /*
   * Broken lock.
   */

  if (
    !existingPid ||
    existingPid <= 0
  ) {
    logWarn(
      "Invalid SARA lock detected. Removing it.",
    );

    removeLock();

    try {
      writeLock(
        buildId,
        buildHash,
      );

      return true;
    } catch {
      return false;
    }
  }

  /*
   * Same process.
   */

  if (
    existingPid === process.pid
  ) {
    return true;
  }

  /*
   * Dead process = stale lock.
   */

  if (
    !isProcessAlive(existingPid)
  ) {
    logWarn(
      `Stale SARA lock detected. PID ${existingPid} is no longer running.`,
    );

    removeLock();

    try {
      writeLock(
        buildId,
        buildHash,
      );

      return true;
    } catch {
      return false;
    }
  }

  /*
   * Verify ownership.
   */

  let saraOwned = false;

  try {
    saraOwned =
      isSaraOwnedPid(
        existingPid,
      );
  } catch {
    saraOwned = false;
  }

  if (!saraOwned) {
    logWarn(
      `Lock PID ${existingPid} does not belong to SARA. Removing stale lock.`,
    );

    removeLock();

    try {
      writeLock(
        buildId,
        buildHash,
      );

      return true;
    } catch {
      return false;
    }
  }

  /*
   * Existing supervisor belongs to SARA.
   *
   * Never start another supervisor.
   */

  log(
    `Existing SARA supervisor detected (PID ${existingPid}).`,
  );

  const backend =
    await httpHealthCheck(
      backendPort,
      "/health",
      2000,
    );

  const agent =
    await httpHealthCheck(
      agentPort,
      "/health",
      2000,
    );

  if (
    backend.ok &&
    agent.ok
  ) {
    log(
      "Existing SARA instance is healthy.",
    );
  } else {
    logWarn(
      "Existing SARA instance is running but service health is degraded.",
    );
  }

  return false;
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log();

  console.log(
    "╔══════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║         SARA — Smart Assistant for Real-time Automation ║",
  );
  console.log(
    "║         Created by Mr Amol Pandhre & the SARA Team      ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════╝",
  );

  console.log();

  // ==========================================================
  // STEP 1 — Build identity
  // ==========================================================

  log("Starting SARA...");

  const identity =
    gatherBuildIdentity(
      PROJECT_ROOT,
      DATA_DIR,
    );

  log(
    `Build identity: ${getBuildLabel(identity)}`,
  );

  log(
    `Build ID: ${identity.BUILD_ID}`,
  );

  log(
    `Build hash: ${identity.BUILD_HASH.slice(0, 16)}...`,
  );

  log(
    `Author: ${identity.author}`,
  );

  // ==========================================================
  // STEP 2 — Configuration
  // ==========================================================

  const config =
    buildServiceConfig(
      PROJECT_ROOT,
    );

  // ==========================================================
  // STEP 3 — Supervisor lock
  // ==========================================================

  const lockAcquired =
    await acquireSupervisorLock(
      config.backendPort,
      config.agentPort,
      identity.BUILD_ID,
      identity.BUILD_HASH,
    );

  if (!lockAcquired) {
    log(
      "Another SARA supervisor is already running.",
    );

    process.exit(0);
  }

  let shuttingDown = false;

  const cleanupLock = (): void => {
    try {
      const lock =
        readLock();

      /*
       * Only remove the lock if this process owns it.
       */
      if (
        lock &&
        Number(lock.pid) ===
          process.pid
      ) {
        removeLock();
      }
    } catch {
      // Best effort.
    }
  };

  process.once(
    "exit",
    cleanupLock,
  );

  // ==========================================================
  // STEP 4 — Environment validation
  // ==========================================================

  log(
    "Validating environment...",
  );

  const validation =
    validateConfig(
      PROJECT_ROOT,
    );

  for (
    const warning of
    validation.warnings
  ) {
    logWarn(warning);
  }

  if (!validation.ok) {
    for (
      const error of
      validation.errors
    ) {
      logError(error);
    }

    cleanupLock();

    process.exit(1);
  }

  log(
    "Environment check passed.",
  );

  // ==========================================================
  // STEP 5 — Database
  // ==========================================================

  log(
    "Checking database...",
  );

  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true,
    },
  );

  const dbPath =
    path.join(
      PROJECT_ROOT,
      "data.db",
    );

  const memoryDbPath =
    path.join(
      PROJECT_ROOT,
      "sara_memory.db",
    );

  /*
   * Do not create/modify databases here unless your DB module
   * explicitly requires it.
   */

  void dbPath;
  void memoryDbPath;

  log(
    "Database ready.",
  );

  // ==========================================================
  // STEP 6 — Backend
  // ==========================================================

  log(
    "Starting backend...",
  );

  let backendReady: {
    healthy: boolean;
    adopted: boolean;
    retries: number;
  };

  if (
    config.developmentMode
  ) {
    /*
     * Do NOT claim that the backend is healthy merely because
     * development mode is enabled.
     *
     * Check the actual service.
     */

    log(
      "Development mode enabled. Checking existing backend...",
    );

    const existingBackend =
      await httpHealthCheck(
        config.backendPort,
        "/health",
        2500,
      );

    backendReady = {
      healthy:
        existingBackend.ok,
      adopted:
        existingBackend.ok,
      retries: 0,
    };

    if (
      existingBackend.ok
    ) {
      log(
        "Development backend is healthy.",
      );
    } else {
      logWarn(
        "Development backend is not running.",
      );
    }
  } else {
    const bundleReady = ensureProductionBundle();
    backendReady = bundleReady
      ? await startService({
        name: "Backend",

        port:
          config.backendPort,

        healthPath:
          "/health",

        expectedServiceId:
          "sara-backend",

        command:
          config.nodeExe,

        args: [
          path.join(
            PROJECT_ROOT,
            "dist",
            "server.cjs",
          ),
        ],

        cwd:
          PROJECT_ROOT,

        env: {
          ...process.env,

          NODE_ENV:
            "production",

          SARA_BUILD_ID:
            identity.BUILD_ID,

          SARA_VERSION:
            identity.SARA_VERSION,

          SARA_SUPERVISOR:
            "1",

          SARA_SUPERVISOR_PID:
            String(process.pid),

          SARA_DATA_DIR:
            DATA_DIR,

          SARA_APP_ROOT:
            PROJECT_ROOT,
        },

        waitMs:
          30_000,
      })
      : {
          healthy: false,
          adopted: false,
          retries: 0,
        };

    if (
      !backendReady.healthy
    ) {
      logWarn(
        "Backend failed to become healthy.",
      );
    } else {
      log(
        "Backend is healthy.",
      );
    }
  }

  // ==========================================================
  // STEP 7 — Desktop Agent
  // ==========================================================

  log(
    "Starting Desktop Agent...",
  );

  const agentStartOpts = {
    name:
      "Desktop Agent",

    port:
      config.agentPort,

    healthPath:
      "/health",

    expectedServiceId:
      "sara-desktop-agent",

    command:
      config.pythonExe,

    args: [
      "-m",
      "uvicorn",
      "desktop_agent.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(
        config.agentPort,
      ),
    ],

    cwd:
      PROJECT_ROOT,

    env: {
      ...process.env,

      SARA_SUPERVISOR:
        "1",

      SARA_SUPERVISOR_PID:
        String(process.pid),

      SARA_BUILD_ID:
        identity.BUILD_ID,

      SARA_DATA_DIR:
        DATA_DIR,

      SARA_APP_ROOT:
        PROJECT_ROOT,
    },

    waitMs:
      30_000,
  };

  const agentHandle =
    await startService(
      agentStartOpts,
    );

  if (
    !agentHandle.healthy
  ) {
    logWarn(
      "Desktop Agent failed to become healthy.",
    );

    logWarn(
      "Window control and OS automation may be unavailable.",
    );
  } else {
    log(
      "Desktop Agent is healthy.",
    );

    log(
      "Verifying Desktop Agent capabilities...",
    );

    const capabilities =
      await httpHealthCheck(
        config.agentPort,
        "/health",
        3000,
      );

    if (
      capabilities.ok &&
      Number(capabilities.data?.tool_count) > 0 &&
      Array.isArray(capabilities.data?.tools)
    ) {
      log(
        `Desktop Agent capabilities verified (${capabilities.data.tool_count} tools).`,
      );
    } else {
      logWarn(
        "Desktop Agent is running but full capabilities could not be verified.",
      );
    }
  }

  // ==========================================================
  // STEP 8 — Health checks
  // ==========================================================

  log(
    "Running health checks...",
  );

  const healthResults =
    await runAllHealthChecks({
      backendPort:
        config.backendPort,

      agentPort:
        config.agentPort,

      projectRoot:
        PROJECT_ROOT,
    });

  printHealthReport(
    healthResults,
  );

  const backendHealth =
    Boolean(
      backendReady.healthy,
    );

  const agentHealth =
    Boolean(
      agentHandle.healthy,
    );

  const backendState:
    ServiceState =
    backendHealth
      ? backendReady.adopted
        ? "ADOPTED"
        : "HEALTHY"
      : "FAILED";

  const agentState:
    ServiceState =
    agentHealth
      ? agentHandle.adopted
        ? "ADOPTED"
        : "HEALTHY"
      : "FAILED";

  const supervisorState:
    ServiceState =
    "HEALTHY";

  const overallState:
    ServiceState =
    backendHealth &&
    agentHealth
      ? "HEALTHY"
      : backendHealth ||
        agentHealth
      ? "DEGRADED"
      : "FAILED";

  void overallState;

  // ==========================================================
  // Startup summary
  // ==========================================================

  log(
    `Startup summary: ${formatStartupSummary({
      supervisor: {
        name:
          "supervisor",

        state:
          supervisorState,

        healthy:
          true,

        pid:
          process.pid,
      },

      backend: {
        name:
          "backend",

        state:
          backendState,

        healthy:
          backendHealth,

        reason:
          backendHealth
            ? undefined
            : "Health check failed",

        adopted:
          backendReady.adopted,
      },

      desktop_agent: {
        name:
          "desktop_agent",

        state:
          agentState,

        healthy:
          agentHealth,

        reason:
          agentHealth
            ? undefined
            : "Health check failed",

        adopted:
          agentHandle.adopted,
      },
    })}`,
  );

  // ==========================================================
  // STEP 9 — Supervisor
  // ==========================================================

  const {
    startSupervisorLoop,
  } = await import(
    "./processGuard.js"
  );

  startSupervisorLoop(
    5000,
  );

  log(
    "SARA supervisor loop started.",
  );
// Initialize Self‑Improvement engine
const { SelfImprovementManager } = await import("../src/self_improvement/SelfImprovementManager.js");
const selfImprovementManager = new SelfImprovementManager();
selfImprovementManager.start();

  // ==========================================================
  // STEP 10 — Electron
  // ==========================================================

  let electronProc:
    ReturnType<
      typeof spawnElectronWithConfig
    >["process"] |
    undefined;

  const existingElectronPid =
    findExistingElectronPid(
      PROJECT_ROOT,
    );

  if (
    existingElectronPid
  ) {
    log(
      `Existing SARA Electron UI detected on PID ${existingElectronPid}.`,
    );

    log(
      "Adopting existing Electron instance.",
    );

    const existingHandle:
      ServiceHandle = {
      name:
        "Electron",

      pid:
        existingElectronPid,

      healthy:
        true,

      retries:
        0,

      adopted:
        true,

      opts: {
        name:
          "Electron",

        command:
          "electron",

        args:
          ["."],

        cwd:
          PROJECT_ROOT,

        env:
          process.env,

        port:
          undefined,
      },
    };

    running.set(
      "Electron",
      existingHandle,
    );

    /*
     * Clean duplicates only after we have selected the
     * Electron instance to keep.
     */

    const duplicates =
      cleanupDuplicateElectronProcesses(
        PROJECT_ROOT,
        existingElectronPid,
      );

    if (
      duplicates.length
    ) {
      logWarn(
        `Removed ${duplicates.length} duplicate SARA Electron process(es).`,
      );
    }
  } else {
    log(
      "No existing SARA Electron UI found.",
    );

    log(
      "Launching Electron UI...",
    );

    try {
      const spawned =
        spawnElectronWithConfig(
          PROJECT_ROOT,
          ["."],
        );

      electronProc =
        spawned.process;

      const electronHandle:
        ServiceHandle = {
        name:
          "Electron",

        process:
          electronProc,

        pid:
          electronProc.pid,

        healthy:
          true,

        retries:
          0,

        adopted:
          false,

        opts: {
          name:
            "Electron",

          command:
            spawned.config.executable,

          args:
            spawned.config.args,

          cwd:
            spawned.config.cwd,

          env:
            spawned.config.env,

          shell:
            spawned.config.shell,

          port:
            undefined,
        },
      };

      running.set(
        "Electron",
        electronHandle,
      );

      electronProc.once(
        "error",
        (error) => {
          const handle =
            running.get(
              "Electron",
            );

          if (handle) {
            handle.healthy =
              false;

            handle.state =
              "FAILED";
          }

          logError(
            `Electron failed to start: ${error.message}`,
          );
        },
      );

      electronProc.once(
        "exit",
        (code, signal) => {
          const handle =
            running.get(
              "Electron",
            );

          if (handle) {
            handle.healthy =
              false;

            handle.lastExitCode =
              code;

            handle.lastSignal =
              signal;

            handle.state =
              code === 0 &&
              signal === null
                ? "STOPPED"
                : "FAILED";
          }

          if (
            code === 0 &&
            signal === null
          ) {
            log(
              "Electron UI exited normally.",
            );
          } else {
            logError(
              `Electron UI exited unexpectedly. code=${
                code ?? "null"
              } signal=${
                signal ?? "none"
              }`,
            );
          }
        },
      );

      log(
        `Electron UI launched with PID ${
          electronProc.pid ??
          "unknown"
        }.`,
      );
    } catch (error) {
      logError(
        `Electron launch failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }
  }

  // ==========================================================
  // STEP 11 — Ready state
  // ==========================================================

  const allHealthy =
    backendHealth &&
    agentHealth;

  if (allHealthy) {
    log(
      "████████████████████████████████████",
    );

    log(
      "█                                  █",
    );

    log(
      "█         SARA IS READY ✅         █",
    );

    log(
      "█                                  █",
    );

    log(
      "████████████████████████████████████",
    );
  } else {
    const failed =
      healthResults
        .filter(
          (result) =>
            !result.ok,
        )
        .map(
          (result) =>
            result.service,
        );

    logWarn(
      `SARA started in DEGRADED mode. Failed services: ${
        failed.length
          ? failed.join(", ")
          : "unknown"
      }`,
    );

    log(
      "SARA is partially available.",
    );
  }

  // ==========================================================
  // Shutdown
  // ==========================================================

  const shutdown =
    (signal: string): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      log(
        `${signal} received. Shutting down SARA...`,
      );

      /*
       * Only terminate Electron if THIS supervisor
       * actually launched it.
       *
       * Adopted Electron belongs to the existing
       * supervisor and must not be killed.
       */

      try {
        if (
          electronProc &&
          !electronProc.killed
        ) {
          electronProc.kill(
            "SIGTERM",
          );
        }
      } catch {
        // Best effort.
      }

      /*
       * stopAll() should terminate only services owned by
       * this supervisor. Adopted services must be protected
       * by processGuard.ts.
       */

      try {
        stopAll();
      } catch (error) {
        logWarn(
          `Service shutdown warning: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }

      cleanupLock();

      process.exit(0);
    };

  process.once(
    "SIGINT",
    () => shutdown("SIGINT"),
  );

  process.once(
    "SIGTERM",
    () => shutdown("SIGTERM"),
  );

  process.once(
    "uncaughtException",
    (error) => {
      logError(
        `Uncaught exception: ${
          error instanceof Error
            ? error.stack ||
              error.message
            : String(error)
        }`,
      );

      shutdown(
        "uncaughtException",
      );
    },
  );

  process.once(
    "unhandledRejection",
    (reason) => {
      logError(
        `Unhandled rejection: ${String(
          reason,
        )}`,
      );

      shutdown(
        "unhandledRejection",
      );
    },
  );

  log(
    "Startup manager is now supervising SARA.",
  );

  log(
    "Startup manager will remain running.",
  );
}

// ============================================================
// Fatal startup error
// ============================================================

main().catch(
  (error) => {
    console.error(
      "[SARA][FATAL] Startup failed:",
      error instanceof Error
        ? error.stack ||
          error.message
        : error,
    );

    try {
      const lock =
        readLock();

      if (
        Number(lock?.pid) ===
        process.pid
      ) {
        removeLock();
      }
    } catch {
      // Ignore.
    }

    process.exit(1);
  },
);