import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";

export interface ResolvedElectronLaunchConfig {
  executable: string;
  cwd: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  diagnostics: string[];
}

/**
 * Resolve a full path to the Electron binary for the current platform.
 * Returns an object suitable for `child_process.spawn`.
 * Throws a descriptive error if no executable can be located.
 *
 * Candidate order (Windows):
 *  1. node_modules/electron/dist/electron.exe  - direct binary, no shell needed
 *  2. node_modules/.bin/electron.cmd           - shim, requires shell:true
 *  3. node_modules/electron/dist/electron      - fallback without extension
 *  4. node_modules/electron/cli.js             - JS entry point (node-driven)
 */
export function resolveElectronLaunchConfig(
  projectRoot: string,
  args: string[] = ["."],
): ResolvedElectronLaunchConfig {
  const diagnostics: string[] = [];
  const cwd = path.resolve(projectRoot);
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(path.join(cwd, "node_modules", "electron", "dist", "electron.exe"));
    candidates.push(path.join(cwd, "node_modules", ".bin", "electron.cmd"));
    candidates.push(path.join(cwd, "node_modules", "electron", "dist", "electron"));
    candidates.push(path.join(cwd, "node_modules", "electron", "cli.js"));
  } else {
    candidates.push(path.join(cwd, "node_modules", "electron", "dist", "electron"));
    candidates.push(path.join(cwd, "node_modules", ".bin", "electron"));
  }

  let resolved = "";
  for (const candidate of candidates) {
    const exists = fs.existsSync(candidate);
    diagnostics.push(`  ${candidate}: ${exists ? "EXISTS" : "missing"}`);
    if (exists) {
      resolved = candidate;
      break;
    }
  }

  if (!resolved) {
    const errMsg =
      "Electron executable not found in any expected location. " +
      "Ensure `npm install` has been run and the `electron` package is installed.";
    diagnostics.push(`  ERROR: ${errMsg}`);
    throw new Error(errMsg);
  }

  // .cmd shims cannot be spawned directly with shell:false on Windows --
  // Node spawn() will return EINVAL for batch files without a shell.
  const shell =
    process.platform === "win32" &&
    path.extname(resolved).toLowerCase() === ".cmd";

  diagnostics.push(`  Resolved: ${resolved}`);
  diagnostics.push(`  shell: ${shell}`);

  return {
    executable: resolved,
    cwd,
    args,
    shell,
    env: {
      ...process.env,
      ELECTRON_ENV: "production",
      SARA_SUPERVISOR: "1",
      SARA_SERVICE_MANAGER: "1",
      SARA_BACKEND_URL: "http://127.0.0.1:3000",
      SARA_DESKTOP_AGENT_URL: "http://127.0.0.1:8765",
    },
    diagnostics,
  };
}

/**
 * Spawn the Electron UI process and return both the ChildProcess and the
 * resolved launch configuration.  Use this variant when you need to register
 * Electron as a supervised ServiceHandle in processGuard.
 */
export function spawnElectronWithConfig(
  projectRoot: string,
  args: string[] = ["."],
): { process: ChildProcess; config: ResolvedElectronLaunchConfig } {
  const config = resolveElectronLaunchConfig(projectRoot, args);

  console.log("[SARA] Electron launch diagnostics:");
  for (const line of config.diagnostics) {
    console.log(`[SARA]${line}`);
  }

  const child = spawn(config.executable, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: "inherit",
    shell: config.shell,
    windowsHide: true,
    detached: false,
  });

  child.on("error", (error: Error) => {
    console.error(`[SARA][ERROR] Electron spawn failed: ${error.message}`);
  });

  child.on("spawn", () => {
    console.log(
      `[SARA] Electron process spawned successfully (PID ${child.pid ?? "unknown"}).`,
    );
  });

  child.on("exit", (code, signal) => {
    if (code === 0 && signal === null) {
      console.log("[SARA] Electron UI exited normally.");
      return;
    }
    console.error(
      `[SARA][ERROR] Electron UI exited with code ${code ?? "unknown"}, signal ${signal ?? "none"}.`,
    );
  });

  return { process: child, config };
}

/**
 * Convenience wrapper — spawns Electron and returns only the ChildProcess.
 * Retained for backward compatibility with callers that do not need the config.
 */
export function spawnElectron(
  projectRoot: string,
  args: string[] = ["."],
): ChildProcess {
  return spawnElectronWithConfig(projectRoot, args).process;
}
