import { execSync, spawn, ChildProcess } from "child_process";
import http from "http";
import path from "path";

export type ProcessLifecycleState =
  | "STARTING"
  | "READY"
  | "FAILED"
  | "RECOVERING"
  | "STOPPING"
  | "STOPPED";

export interface ProcessLaunchOptions {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe" | [any, any, any];
  healthPath?: string;
  expectedServiceId?: string;
  port?: number;
  waitMs?: number;
}

export interface ManagedProcessResult {
  child: ChildProcess;
  executable: string;
  args: string[];
  cwd: string;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  startedAt: number;
  stdout: string;
  stderr: string;
}

// ============================================================
// SARA PROCESS GUARD
//
// Responsibilities:
// - Prevent duplicate service instances
// - Check service health
// - Recover crashed services
// - Avoid overlapping recovery attempts
// - Avoid aggressive health-request loops
// - Safely terminate SARA-owned processes
// ============================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DEFAULT_HEALTH_TIMEOUT_MS = 2500;
const DEFAULT_HEALTH_INTERVAL_MS = 5000;
const MAX_HEALTH_BODY_SIZE = 64 * 1024;

export interface ServiceHandle {
  name: string;
  process?: ChildProcess;
  pid?: number;
  port?: number;

  healthy: boolean;

  retries: number;

  adopted?: boolean;

  opts?: any;

  consecutiveFailures?: number;

  state?: ProcessLifecycleState;

  startedAt?: number;

  startupDurationMs?: number;

  lastExitCode?: number | null;

  lastSignal?: NodeJS.Signals | null;

  /**
   * Prevents multiple recovery operations from running
   * at the same time for the same service.
   */
  recovering?: boolean;

  /**
   * Prevents overlapping health checks.
   */
  healthCheckInFlight?: boolean;

  /**
   * Used to ignore an old ChildProcess exit event after
   * a replacement process has already been installed.
   */
  generation?: number;
}

const running = new Map<string, ServiceHandle>();

// ============================================================
// HEALTH STATE
// ============================================================

export function applyHealthState(
  handle: ServiceHandle,
  healthy: boolean,
  threshold = 2
): ServiceHandle {
  const previousHealthy = handle.healthy;

  if (healthy) {
    handle.consecutiveFailures = 0;

    if (!previousHealthy) {
      handle.healthy = true;

      console.log(`[SARA] ${handle.name} health restored.`);
      console.log(`[SARA] ${handle.name}: HEALTHY`);
    }

    return handle;
  }

  const failures = (handle.consecutiveFailures ?? 0) + 1;
  handle.consecutiveFailures = failures;

  if (previousHealthy && failures >= threshold) {
    handle.healthy = false;

    console.error(
      `[SARA][WARN] ${handle.name} unhealthy after ${failures} failed health checks.`
    );
  }

  return handle;
}

// ============================================================
// PROCESS TABLE
// ============================================================

function parseProcessLine(
  rawLine: string
): { pid: number | null; cmd: string } {
  const line = rawLine.trim();

  if (!line) {
    return {
      pid: null,
      cmd: "",
    };
  }

  if (line.includes(",")) {
    const parts = line.split(",");

    const maybePid = Number.parseInt(
      parts[0]?.trim() || "",
      10
    );

    const cmd = parts
      .slice(1)
      .join(",")
      .trim();

    if (
      Number.isFinite(maybePid) &&
      maybePid > 0
    ) {
      return {
        pid: maybePid,
        cmd,
      };
    }
  }

  const match = line.match(
    /(?:^|\s)(\d+)\s+(.+)$/
  );

  if (match) {
    const pid = Number.parseInt(
      match[1],
      10
    );

    if (
      Number.isFinite(pid) &&
      pid > 0
    ) {
      return {
        pid,
        cmd: match[2] || "",
      };
    }
  }

  return {
    pid: null,
    cmd: line,
  };
}

function getWindowsProcessTable(): string {
  const attempts = [
    "wmic process get ProcessId,CommandLine /format:csv",

    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"',
  ];

  for (const command of attempts) {
    try {
      return execSync(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }).toString();
    } catch {
      // Continue to next method.
    }
  }

  return "";
}

// ============================================================
// SARA OWNERSHIP
// ============================================================

function isSaraCommandLine(cmd: string): boolean {
  try {
    const normalized = (cmd || "")
      .toLowerCase()
      .replace(/\\/g, "/");

    return (
      normalized.includes("myraa-ai-assistant") ||
      normalized.includes("sara") ||
      normalized.includes("sara_supvisor") ||
      normalized.includes("desktop_agent.main") ||
      normalized.includes("dist/server.cjs")
    );
  } catch {
    return false;
  }
}

export function isSaraOwnedPid(
  pid: number
): boolean {
  if (
    !Number.isFinite(pid) ||
    pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "win32") {
    return false;
  }

  try {
    const out = getWindowsProcessTable();

    for (const line of out.split(/\r?\n/)) {
      const parsed = parseProcessLine(line);

      if (!parsed.pid) continue;

      if (parsed.pid !== pid) continue;

      return isSaraCommandLine(
        parsed.cmd
      );
    }
  } catch {
    // Ignore process-table errors.
  }

  return false;
}

export function findSaraOwnedPids(): number[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const out = getWindowsProcessTable();

    const pids = new Set<number>();

    for (const line of out.split(/\r?\n/)) {
      const parsed = parseProcessLine(line);

      if (!parsed.pid) continue;

      if (
        isSaraCommandLine(parsed.cmd)
      ) {
        pids.add(parsed.pid);
      }
    }

    return [...pids];
  } catch {
    return [];
  }
}

// ============================================================
// LOCK
// ============================================================

export function evaluateLockPid(
  pid: number | undefined | null
): {
  stale: boolean;
  reason: string;
} {
  if (
    !pid ||
    !Number.isFinite(pid) ||
    pid <= 0
  ) {
    return {
      stale: true,
      reason: "Lock PID is invalid",
    };
  }

  try {
    process.kill(pid, 0);
  } catch {
    return {
      stale: true,
      reason: "Referenced PID no longer exists",
    };
  }

  const owner = isSaraOwnedPid(pid);

  return {
    stale: !owner,
    reason: owner
      ? "Lock owner matches a live SARA process"
      : "Lock owner is not a live SARA process",
  };
}

// ============================================================
// PORT OWNER
// ============================================================

export function getPortOwnerPid(
  port: number
): number | null {
  if (
    !Number.isFinite(port) ||
    port <= 0
  ) {
    return null;
  }

  try {
    const out = execSync(
      `netstat -ano -p TCP`,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
        windowsHide: true,
      }
    ).toString();

    for (const line of out.split(/\r?\n/)) {
      const match = line.match(
        /:(\d+)\s+\S+\s+LISTEN(?:ING)?\s+(\d+)/i
      );

      if (!match) continue;

      const foundPort =
        Number.parseInt(
          match[1],
          10
        );

      if (foundPort !== port) {
        continue;
      }

      const pid =
        Number.parseInt(
          match[2],
          10
        );

      if (
        Number.isFinite(pid) &&
        pid > 0
      ) {
        return pid;
      }
    }
  } catch {
    // Ignore netstat errors.
  }

  return null;
}

// ============================================================
// SAFE TERMINATION
// ============================================================

function terminatePidIfSaraOwned(
  pid: number | undefined | null
): boolean {
  if (
    !pid ||
    !Number.isFinite(pid) ||
    pid <= 0
  ) {
    return false;
  }

  if (!isSaraOwnedPid(pid)) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      execSync(
        `taskkill /PID ${pid} /T /F`,
        {
          stdio: "ignore",
          windowsHide: true,
        }
      );
    } else {
      process.kill(pid, "SIGTERM");
    }

    console.log(
      `[SARA] Terminated stale SARA-owned PID ${pid}.`
    );

    return true;
  } catch {
    return false;
  }
}

export function terminateSaraOwnedProcesses(): void {
  for (const pid of findSaraOwnedPids()) {
    try {
      if (pid === process.pid) {
        continue;
      }

      terminatePidIfSaraOwned(pid);
    } catch {
      // Ignore already-dead processes.
    }
  }
}

// ============================================================
// HEALTH CHECK
//
// IMPORTANT:
//
// This implementation deliberately uses Node's native http
// client and closes the response cleanly.
//
// There is NO AbortController here because Node's http.get()
// does not need it for this simple health check.
//
// The previous implementation created an AbortController but
// never passed its signal to http.get(), so it did nothing.
// ============================================================

export async function isPortHealthy(
  port: number,
  path_ = "/health"
): Promise<{
  healthy: boolean;
  data?: any;
}> {
  return new Promise((resolve) => {
    let settled = false;

    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (
      result: {
        healthy: boolean;
        data?: any;
      }
    ) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve(result);
    };

    if (
      !Number.isFinite(port) ||
      port <= 0
    ) {
      finish({
        healthy: false,
      });

      return;
    }

    const normalizedPath =
      path_ && path_.startsWith("/")
        ? path_
        : `/${path_ || "health"}`;

    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: normalizedPath,
        method: "GET",

        headers: {
          Accept: "application/json",
          Connection: "close",
          "Cache-Control": "no-cache",
        },

        agent: false,

        timeout:
          DEFAULT_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = "";

        let bodySize = 0;

        res.setEncoding("utf8");

        res.on(
          "data",
          (chunk: string) => {
            bodySize += Buffer.byteLength(
              chunk,
              "utf8"
            );

            if (
              bodySize >
              MAX_HEALTH_BODY_SIZE
            ) {
              res.resume();

              finish({
                healthy: false,
              });

              return;
            }

            body += chunk;
          }
        );

        res.on(
          "end",
          () => {
            const statusCode =
              res.statusCode ?? 0;

            if (
              statusCode !== 200
            ) {
              finish({
                healthy: false,
              });

              return;
            }

            if (!body.trim()) {
              finish({
                healthy: true,
              });

              return;
            }

            try {
              const data =
                JSON.parse(body);

              finish({
                healthy: true,
                data,
              });
            } catch {
              // A 200 response is still considered
              // healthy even if the endpoint returns
              // plain text instead of JSON.
              finish({
                healthy: true,
              });
            }
          }
        );

        res.on(
          "aborted",
          () => {
            finish({
              healthy: false,
            });
          }
        );

        res.on(
          "error",
          () => {
            finish({
              healthy: false,
            });
          }
        );
      }
    );

    timeoutId = setTimeout(
      () => {
        try {
          req.destroy();
        } catch {
          // Ignore.
        }

        finish({
          healthy: false,
        });
      },
      DEFAULT_HEALTH_TIMEOUT_MS + 250
    );

    req.on(
      "timeout",
      () => {
        try {
          req.destroy();
        } catch {
          // Ignore.
        }

        finish({
          healthy: false,
        });
      }
    );

    req.on(
      "error",
      () => {
        finish({
          healthy: false,
        });
      }
    );
  });
}

// ============================================================
// PORT PROCESS
// ============================================================

export function killPortProcess(
  port: number
): void {
  const pid =
    getPortOwnerPid(port);

  if (!pid) {
    return;
  }

  if (!isSaraOwnedPid(pid)) {
    console.warn(
      `[SARA] Refusing to kill PID ${pid} on port ${port} because it is not SARA-owned.`
    );

    return;
  }

  terminatePidIfSaraOwned(pid);
}

// ============================================================
// WAIT FOR HEALTH
// ============================================================

export async function waitForPort(
  port: number,
  healthPath = "/health",
  maxWaitMs = 30_000,
  intervalMs = 1000
): Promise<boolean> {
  const deadline =
    Date.now() + maxWaitMs;

  while (
    Date.now() < deadline
  ) {
    const result =
      await isPortHealthy(
        port,
        healthPath
      );

    if (result.healthy) {
      return true;
    }

    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          intervalMs
        )
    );
  }

  return false;
}

// ============================================================
// WINDOWS COMMAND RESOLUTION
// ============================================================

function resolveSpawnExecutable(
  command: string
): string {
  const trimmed =
    (command || "").trim();

  if (!trimmed) {
    return command;
  }

  if (
    process.platform !== "win32"
  ) {
    return trimmed;
  }

  const normalized =
    trimmed.toLowerCase();

  const packageManagers = [
    "npm",
    "npx",
    "pnpm",
    "yarn",
  ];

  if (
    packageManagers.includes(
      normalized
    )
  ) {
    return "cmd.exe";
  }

  const hasExplicitExtension =
    path.extname(trimmed).length > 0;

  const hasPathSeparator =
    trimmed.includes("\\") ||
    trimmed.includes("/");

  if (
    !hasExplicitExtension &&
    !hasPathSeparator &&
    (
      normalized === "node" ||
      normalized === "python" ||
      normalized === "py"
    )
  ) {
    return `${trimmed}.exe`;
  }

  return trimmed;
}

function resolveSpawnArgs(
  command: string,
  args: string[]
): string[] {
  const trimmed =
    (command || "").trim();

  if (
    process.platform !== "win32"
  ) {
    return args;
  }

  const normalized =
    trimmed.toLowerCase();

  const packageManagers = [
    "npm",
    "npx",
    "pnpm",
    "yarn",
  ];

  if (
    packageManagers.includes(
      normalized
    )
  ) {
    return [
      "/d",
      "/s",
      "/c",
      trimmed,
      ...args,
    ];
  }

  if (
    /\.cmd$/i.test(trimmed)
  ) {
    return [
      "/d",
      "/s",
      "/c",
      trimmed,
      ...args,
    ];
  }

  return args;
}

// ============================================================
// SPAWN
// ============================================================

export function spawnManagedProcess(
  opts: ProcessLaunchOptions
): ManagedProcessResult {
  const startedAt = Date.now();

  const command =
    resolveSpawnExecutable(
      opts.command
    );

  const args =
    resolveSpawnArgs(
      opts.command,
      opts.args ?? []
    );

  const cwd =
    opts.cwd || process.cwd();

  const env = {
    ...process.env,
    ...(opts.env ?? {}),
  };

  const stdio =
    opts.stdio ??
    ["ignore", "pipe", "pipe"];

  const child = spawn(
    command,
    args,
    {
      cwd,
      env,
      stdio,
      shell: false,

      // Prevent Windows from creating
      // another visible console window.
      windowsHide: true,
    }
  );

  const result: ManagedProcessResult = {
    child,

    executable: command,

    args,

    cwd,

    pid: child.pid,

    exitCode: null,

    signal: null,

    durationMs: 0,

    startedAt,

    stdout: "",

    stderr: "",
  };

  const captureStdout = (
    chunk: Buffer | string
  ) => {
    result.stdout +=
      chunk.toString();
  };

  const captureStderr = (
    chunk: Buffer | string
  ) => {
    result.stderr +=
      chunk.toString();
  };

  if (child.stdout) {
    child.stdout.on(
      "data",
      captureStdout
    );
  }

  if (child.stderr) {
    child.stderr.on(
      "data",
      captureStderr
    );
  }

  child.once(
    "spawn",
    () => {
      console.log(
        `[SARA] Process spawn diagnostics for ${opts.name}:`
      );

      console.log(
        `[SARA]   executable: ${command}`
      );

      console.log(
        `[SARA]   args: ${JSON.stringify(args)}`
      );

      console.log(
        `[SARA]   cwd: ${cwd}`
      );

      console.log(
        `[SARA]   pid: ${child.pid ?? "unknown"}`
      );
    }
  );

  child.once(
    "exit",
    (code, signal) => {
      result.exitCode =
        code;

      result.signal =
        signal;

      result.durationMs =
        Date.now() -
        startedAt;

      console.log(
        `[SARA] ${opts.name} exited with code ${
          code ?? "null"
        } signal ${
          signal ?? "none"
        } after ${
          result.durationMs
        }ms (PID ${
          child.pid ?? "unknown"
        }).`
      );
    }
  );

  child.once(
    "error",
    (err: Error) => {
      console.error(
        `[SARA] Failed to spawn ${opts.name} using ${command}: ${err.message}`
      );
    }
  );

  return result;
}

// ============================================================
// SERVICE START
// ============================================================

export async function startService(
  serviceOpts: {
    name: string;
    port: number;
    healthPath?: string;
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    waitMs?: number;
    expectedServiceId?: string;
  }
): Promise<ServiceHandle> {
  const {
    name,
    port,
    healthPath = "/health",
    command,
    args,
    cwd,
    env,
    waitMs = 30_000,
    expectedServiceId,
  } = serviceOpts;

  const opts = serviceOpts;

  // ----------------------------------------------------------
  // Existing in-memory service
  // ----------------------------------------------------------

  const runningHandle =
    running.get(name);

  if (
    runningHandle &&
    runningHandle.state ===
      "STOPPING"
  ) {
    console.log(
      `[SARA] ${name} is currently stopping. Refusing duplicate start.`
    );

    return runningHandle;
  }

  // ----------------------------------------------------------
  // Check current port
  // ----------------------------------------------------------

  const portOwnerPid =
    getPortOwnerPid(port);

  const healthRes =
    await isPortHealthy(
      port,
      healthPath
    );

  // ----------------------------------------------------------
  // Already healthy + managed
  // ----------------------------------------------------------

  if (
    healthRes.healthy &&
    runningHandle &&
    runningHandle.port === port
  ) {
    console.log(
      `[SARA] Reusing healthy ${name} on port ${port}.`
    );

    runningHandle.healthy =
      true;

    runningHandle.adopted =
      true;

    runningHandle.state =
      "READY";

    runningHandle.consecutiveFailures =
      0;

    return runningHandle;
  }

  const isOwnerMismatch =
    healthRes.healthy &&
    expectedServiceId &&
    (!healthRes.data?.service || healthRes.data.service !== expectedServiceId);

  if (isOwnerMismatch && portOwnerPid && isSaraOwnedPid(portOwnerPid)) {
    console.warn(
      `[SARA] Port ${port} is occupied by a stale SARA-owned service with identity '${healthRes.data?.service ?? "undefined"}' instead of '${expectedServiceId}'. Restarting it with the expected identity.`
    );

    terminatePidIfSaraOwned(portOwnerPid);

    await new Promise((resolve) => setTimeout(resolve, 500));
  } else if (isOwnerMismatch) {
    console.warn(
      `[SARA] Port ${port} is healthy but identity is '${healthRes.data?.service ?? "undefined"}' instead of expected '${expectedServiceId}'.`
    );

    return {
      name,
      pid:
        portOwnerPid ??
        undefined,
      port,
      healthy: false,
      retries: 0,
      adopted: false,
      opts,
      consecutiveFailures: 0,
      state: "FAILED",
    };
  }

  // ----------------------------------------------------------
  // Existing healthy external service
  // ----------------------------------------------------------

  if (
    healthRes.healthy &&
    portOwnerPid
  ) {
    if (
      expectedServiceId &&
      healthRes.data?.service ===
        expectedServiceId
    ) {
      const isAlreadyTracked = !!runningHandle && runningHandle.port === port;
      console.log(
        `[SARA] Existing ${name} detected on port ${port}; service identity matches. adopted=${String(isAlreadyTracked)}.`
      );

      const handle: ServiceHandle = {
        name,
        pid: portOwnerPid,
        port,
        healthy: true,
        retries: 0,
        adopted: isAlreadyTracked,
        opts,
        consecutiveFailures: 0,
        state: "READY",
        generation: 1,
      };

      running.set(
        name,
        handle
      );

      return handle;
    }

    if (
      !expectedServiceId &&
      isSaraOwnedPid(
        portOwnerPid
      )
    ) {
      console.log(
        `[SARA] Existing SARA-owned ${name} detected on port ${port}.`
      );

      const handle: ServiceHandle = {
        name,
        pid: portOwnerPid,
        port,
        healthy: true,
        retries: 0,
        adopted: true,
        opts,
        consecutiveFailures: 0,
        state: "READY",
        generation: 1,
      };

      running.set(
        name,
        handle
      );

      return handle;
    }

    console.warn(
      `[SARA] Port ${port} is occupied by an unrelated healthy process.`
    );

    return {
      name,
      pid: portOwnerPid,
      port,
      healthy: false,
      retries: 0,
      adopted: false,
      opts,
      consecutiveFailures: 0,
      state: "FAILED",
    };
  }

  // ----------------------------------------------------------
  // Existing unhealthy process
  // ----------------------------------------------------------

  if (portOwnerPid) {
    if (
      !isSaraOwnedPid(
        portOwnerPid
      )
    ) {
      console.error(
        `[SARA] Port ${port} is occupied by unrelated PID ${portOwnerPid}. Refusing to terminate it.`
      );

      const handle: ServiceHandle = {
        name,
        pid: portOwnerPid,
        port,
        healthy: false,
        retries: 0,
        adopted: false,
        opts,
        consecutiveFailures: 1,
        state: "FAILED",
        generation: 1,
      };

      running.set(
        name,
        handle
      );

      return handle;
    }

    console.warn(
      `[SARA] Unhealthy SARA-owned PID ${portOwnerPid} found on port ${port}. Terminating it before restart.`
    );

    terminatePidIfSaraOwned(
      portOwnerPid
    );

    // Give Windows a moment to release
    // the listening socket.
    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          500
        )
    );
  }

  // ----------------------------------------------------------
  // Spawn
  // ----------------------------------------------------------

  const resolvedCommand =
    resolveSpawnExecutable(
      command
    );

  const spawnArgs =
    resolveSpawnArgs(
      command,
      args
    );

  const startedAt =
    Date.now();

  console.log(
    `[SARA] Starting ${name} (${resolvedCommand} ${spawnArgs.join(
      " "
    )})...`
  );

  const managed =
    spawnManagedProcess({
      name,
      command: resolvedCommand,
      args: spawnArgs,
      cwd,
      env,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
      port,
      waitMs,
      healthPath,
      expectedServiceId,
    });

  const child =
    managed.child;

  const generation =
    (runningHandle?.generation ??
      0) + 1;

  const handle: ServiceHandle = {
    name,

    process: child,

    pid: child.pid,

    port,

    healthy: false,

    retries:
      runningHandle?.retries ??
      0,

    adopted: false,

    opts,

    consecutiveFailures: 0,

    state: "STARTING",

    startedAt,

    recovering: false,

    healthCheckInFlight: false,

    generation,
  };

  running.set(
    name,
    handle
  );

  // ----------------------------------------------------------
  // Process output
  // ----------------------------------------------------------

  child.stdout?.on(
    "data",
    (d) => {
      const msg =
        d.toString().trim();

      if (msg) {
        console.log(
          `[${name}] ${msg}`
        );
      }
    }
  );

  child.stderr?.on(
    "data",
    (d) => {
      const msg =
        d.toString().trim();

      if (msg) {
        console.error(
          `[${name}][ERR] ${msg}`
        );
      }
    }
  );

  // ----------------------------------------------------------
  // Spawn error
  // ----------------------------------------------------------

  child.once(
    "error",
    (err: any) => {
      const current =
        running.get(name);

      if (
        !current ||
        current.generation !==
          generation
      ) {
        return;
      }

      current.healthy =
        false;

      current.state =
        "FAILED";

      console.error(
        `[SARA] ${name} spawn error: ${
          err?.message || err
        }`
      );
    }
  );

  // ----------------------------------------------------------
  // Exit
  // ----------------------------------------------------------

  child.once(
    "exit",
    (code, signal) => {
      const current =
        running.get(name);

      if (
        !current ||
        current.generation !==
          generation
      ) {
        return;
      }

      current.healthy =
        false;

      current.lastExitCode =
        code;

      current.lastSignal =
        signal;

      if (
        current.state !==
        "STOPPING"
      ) {
        current.state =
          "FAILED";
      }

      console.error(
        `[SARA] ${name} exited. code=${
          code ?? "null"
        }, signal=${
          signal ?? "none"
        }`
      );

      if (
        code !== 0 &&
        code !== null &&
        current.state !==
          "STOPPING" &&
        !current.adopted
      ) {
        attemptRecovery(
          name,
          opts
        ).catch(
          (err) => {
            console.error(
              `[SARA] Recovery error for ${name}:`,
              err
            );
          }
        );
      }
    }
  );

  // ----------------------------------------------------------
  // Wait for health
  // ----------------------------------------------------------

  const ready =
    await waitForPort(
      port,
      healthPath,
      waitMs
    );

  // The process might have exited
  // while we were waiting.
  const current =
    running.get(name);

  if (
    !current ||
    current.generation !==
      generation
  ) {
    return handle;
  }

  handle.healthy =
    ready;

  handle.state =
    ready
      ? "READY"
      : "FAILED";

  handle.startupDurationMs =
    Date.now() -
    startedAt;

  if (ready) {
    handle.retries = 0;

    handle.consecutiveFailures =
      0;

    console.log(
      `[SARA] ✓ ${name} is READY on port ${port}.`
    );
  } else {
    console.error(
      `[SARA] ✗ ${name} did NOT become healthy within ${
        waitMs / 1000
      }s.`
    );

    diagnosticHint(
      name,
      port,
      cwd
    );
  }

  return handle;
}

// ============================================================
// RECOVERY
// ============================================================

async function attemptRecovery(
  name: string,
  opts: Parameters<
    typeof startService
  >[0]
): Promise<void> {
  const handle =
    running.get(name);

  if (!handle) {
    return;
  }

  // ----------------------------------------------------------
  // CRITICAL FIX:
  // Prevent overlapping recovery attempts.
  // ----------------------------------------------------------

  if (
    handle.recovering
  ) {
    console.log(
      `[SARA] Recovery for ${name} is already in progress. Skipping duplicate recovery request.`
    );

    return;
  }

  if (
    handle.state ===
    "STOPPING"
  ) {
    return;
  }

  if (
    handle.retries >=
    MAX_RETRIES
  ) {
    console.error(
      `[SARA] ${name} exceeded maximum retries (${MAX_RETRIES}).`
    );

    handle.state =
      "FAILED";

    return;
  }

  handle.recovering =
    true;

  handle.state =
    "RECOVERING";

  handle.retries++;

  const attempt =
    handle.retries;

  console.log(
    `[SARA] Recovery attempt ${attempt}/${MAX_RETRIES} for ${name} in ${
      RETRY_DELAY_MS / 1000
    }s...`
  );

  try {
    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          RETRY_DELAY_MS
        )
    );

    const current =
      running.get(name);

    if (!current) {
      return;
    }

    if (
      current.state ===
      "STOPPING"
    ) {
      return;
    }

    // --------------------------------------------------------
    // Kill stale SARA process if necessary.
    // --------------------------------------------------------

    if (
      current.process &&
      !current.process.killed
    ) {
      try {
        if (
          process.platform ===
          "win32" &&
          current.pid
        ) {
          terminatePidIfSaraOwned(
            current.pid
          );
        } else {
          current.process.kill(
            "SIGTERM"
          );
        }
      } catch {
        // Ignore.
      }
    }

    // Give the OS time to release the
    // process/socket.
    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          750
        )
    );

    // --------------------------------------------------------
    // Start replacement.
    // --------------------------------------------------------

    current.recovering =
      false;

    await startService(
      opts
    );

    const after =
      running.get(name);

    if (
      after &&
      after.healthy
    ) {
      after.retries = 0;

      after.recovering =
        false;

      after.state =
        "READY";

      console.log(
        `[SARA] ${name} recovery successful.`
      );
    }
  } catch (error) {
    const current =
      running.get(name);

    if (current) {
      current.recovering =
        false;

      current.state =
        "FAILED";
    }

    console.error(
      `[SARA] Recovery failed for ${name}:`,
      error
    );
  }
}

// ============================================================
// PROCESS-BASED RECOVERY
// ============================================================

async function attemptRecoveryProcess(
  name: string,
  handle: ServiceHandle
): Promise<void> {
  if (
    handle.recovering
  ) {
    console.log(
      `[SARA] Recovery for ${name} already running.`
    );

    return;
  }

  if (
    handle.retries >=
    MAX_RETRIES
  ) {
    console.error(
      `[SARA] ${name} exceeded maximum retries (${MAX_RETRIES}).`
    );

    handle.state =
      "FAILED";

    return;
  }

  if (
    handle.state ===
    "STOPPING"
  ) {
    return;
  }

  handle.recovering =
    true;

  handle.state =
    "RECOVERING";

  handle.retries++;

  console.log(
    `[SARA] Recovery attempt ${handle.retries}/${MAX_RETRIES} for ${name} in ${
      RETRY_DELAY_MS / 1000
    }s...`
  );

  try {
    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          RETRY_DELAY_MS
        )
    );

    const opts =
      handle.opts;

    if (
      !opts?.command
    ) {
      console.error(
        `[SARA] ${name} has no stored launch command.`
      );

      handle.recovering =
        false;

      handle.state =
        "FAILED";

      return;
    }

    const managed =
      spawnManagedProcess({
        name,
        command:
          resolveSpawnExecutable(
            opts.command
          ),
        args:
          resolveSpawnArgs(
            opts.command,
            opts.args || []
          ),
        cwd:
          opts.cwd ||
          process.cwd(),
        env:
          opts.env ||
          {},
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      });

    const child =
      managed.child;

    handle.process =
      child;

    handle.pid =
      child.pid;

    handle.healthy =
      false;

    handle.state =
      "STARTING";

    child.stdout?.on(
      "data",
      (d) => {
        const msg =
          d.toString().trim();

        if (msg) {
          console.log(
            `[${name}] ${msg}`
          );
        }
      }
    );

    child.stderr?.on(
      "data",
      (d) => {
        const msg =
          d.toString().trim();

        if (msg) {
          console.error(
            `[${name}][ERR] ${msg}`
          );
        }
      }
    );

    child.once(
      "exit",
      (code, signal) => {
        handle.healthy =
          false;

        handle.lastExitCode =
          code;

        handle.lastSignal =
          signal;

        handle.state =
          "FAILED";

        console.error(
          `[SARA] ${name} exited again. code=${
            code ?? "null"
          }, signal=${
            signal ?? "none"
          }`
        );

        if (
          code !== 0 &&
          code !== null
        ) {
          attemptRecoveryProcess(
            name,
            handle
          ).catch(() => {});
        }
      }
    );

    // Do NOT mark the process healthy
    // immediately after spawn.
    //
    // Give the process a short grace period
    // to establish itself.
    await new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          1000
        )
    );

    if (
      child.exitCode !== null
    ) {
      handle.healthy =
        false;

      handle.state =
        "FAILED";

      handle.recovering =
        false;

      return;
    }

    handle.healthy =
      true;

    handle.state =
      "READY";

    handle.recovering =
      false;

    console.log(
      `[SARA] ${name} restarted successfully (PID ${
        child.pid ??
        "unknown"
      }).`
    );
  } catch (error) {
    handle.healthy =
      false;

    handle.state =
      "FAILED";

    handle.recovering =
      false;

    console.error(
      `[SARA] Failed to recover ${name}:`,
      error
    );
  }
}

// ============================================================
// DIAGNOSTICS
// ============================================================

function diagnosticHint(
  name: string,
  port: number,
  cwd: string
): void {
  console.error(
    `\n[SARA] ─── Diagnostic: ${name} ─────────────────`
  );

  console.error(
    `[SARA]   Working directory: ${cwd}`
  );

  console.error(
    `[SARA]   Expected port: ${port}`
  );

  console.error(
    `[SARA]   Possible causes:`
  );

  console.error(
    `[SARA]     • Required dependency is missing`
  );

  console.error(
    `[SARA]     • Port ${port} is occupied`
  );

  console.error(
    `[SARA]     • Process crashed during startup`
  );

  console.error(
    `[SARA]     • Health endpoint is unavailable`
  );

  console.error(
    `[SARA]     • Insufficient permissions`
  );

  console.error(
    `[SARA] ─────────────────────────────────────────────\n`
  );
}

// ============================================================
// SUPERVISOR
// ============================================================

let supervisorTimer:
  NodeJS.Timeout | null = null;

export function startSupervisorLoop(
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS
): void {
  if (supervisorTimer) {
    return;
  }

  supervisorTimer =
    setInterval(
      async () => {
        for (
          const [
            name,
            handle,
          ] of running.entries()
        ) {
          // --------------------------------------------------
          // STOPPING
          // --------------------------------------------------

          if (
            handle.state ===
            "STOPPING"
          ) {
            continue;
          }

          // --------------------------------------------------
          // PORT SERVICE
          // --------------------------------------------------

          if (
            handle.port
          ) {
            // Prevent overlapping
            // health checks.
            if (
              handle.healthCheckInFlight
            ) {
              continue;
            }

            handle.healthCheckInFlight =
              true;

            try {
              const res =
                await isPortHealthy(
                  handle.port,
                  handle.opts
                    ?.healthPath ||
                    "/health"
                );

              if (
                res.healthy
              ) {
                applyHealthState(
                  handle,
                  true,
                  2
                );

                if (
                  handle.state !==
                  "STARTING"
                ) {
                  handle.state =
                    "READY";
                }

                continue;
              }

              const next =
                applyHealthState(
                  handle,
                  false,
                  2
                );

              // Only recover after
              // threshold failures.
              if (
                next.consecutiveFailures! <
                2
              ) {
                continue;
              }

              if (
                handle.recovering
              ) {
                continue;
              }

              if (
                handle.adopted
              ) {
                console.warn(
                  `[SARA] ${name} is an adopted service. Automatic process recovery is disabled because SARA does not own its ChildProcess handle.`
                );

                continue;
              }

              if (
                handle.retries >=
                MAX_RETRIES
              ) {
                continue;
              }

              console.log(
                `[SARA] ${name} failed consecutive health checks. Starting controlled recovery...`
              );

              attemptRecovery(
                name,
                handle.opts
              ).catch(
                (error) => {
                  console.error(
                    `[SARA] Supervisor recovery error for ${name}:`,
                    error
                  );
                }
              );
            } finally {
              handle.healthCheckInFlight =
                false;
            }

            continue;
          }

          // --------------------------------------------------
          // PROCESS SERVICE WITHOUT PORT
          // --------------------------------------------------

          if (
            handle.process
          ) {
            const exited =
              handle.process
                .exitCode !== null;

            if (
              exited &&
              handle.healthy
            ) {
              handle.healthy =
                false;

              const code =
                handle.process
                  .exitCode;

              console.error(
                `[SARA][WARN] ${name} process exited (code ${
                  code ??
                  "unknown"
                }).`
              );

              if (
                code !== 0 &&
                handle.retries <
                  MAX_RETRIES &&
                !handle.adopted &&
                !handle.recovering
              ) {
                attemptRecoveryProcess(
                  name,
                  handle
                ).catch(
                  () => {}
                );
              }
            }
          }
        }
      },
      intervalMs
    );
}

// ============================================================
// STOP ALL
// ============================================================

export function stopAll(): void {
  if (
    supervisorTimer
  ) {
    clearInterval(
      supervisorTimer
    );

    supervisorTimer =
      null;
  }

  for (
    const [
      name,
      handle,
    ] of running.entries()
  ) {
    handle.state =
      "STOPPING";

    handle.healthy =
      false;

    console.log(
      `[SARA] Stopping ${name}...`
    );

    try {
      if (
        handle.pid &&
        process.platform ===
          "win32"
      ) {
        terminatePidIfSaraOwned(
          handle.pid
        );
      } else if (
        handle.process &&
        !handle.process.killed
      ) {
        handle.process.kill(
          "SIGTERM"
        );
      }
    } catch {
      // Ignore shutdown errors.
    }
  }

  running.clear();
}

// ============================================================
// PUBLIC ACCESS
// ============================================================

export {
  running,
};