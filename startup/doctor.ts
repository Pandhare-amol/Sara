import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSaraOwnedPids, terminateSaraOwnedProcesses, isSaraOwnedPid } from "./processGuard.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.find((arg) => arg === "--status" || arg === "--doctor" || arg === "--stop" || arg === "--restart") || "--doctor";

async function healthCheck(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { ok: res.ok, status: res.status };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function reportStatus(): Promise<void> {
  const backend = await healthCheck("http://127.0.0.1:3000/health");
  const agent = await healthCheck("http://127.0.0.1:8765/health");
  const pids = findSaraOwnedPids();
  console.log("[SARA][DOCTOR] status");
  console.log(`Backend: ${backend.ok ? "HEALTHY" : "DOWN"}${backend.status ? ` (${backend.status})` : ""}`);
  console.log(`Desktop Agent: ${agent.ok ? "HEALTHY" : "DOWN"}${agent.status ? ` (${agent.status})` : ""}`);
  console.log(`SARA-owned PIDs: ${pids.length ? pids.join(", ") : "none"}`);
  if (!backend.ok || !agent.ok) {
    process.exitCode = 1;
  }
}

function stopServices(): void {
  const pids = findSaraOwnedPids();
  if (pids.length === 0) {
    console.log("[SARA][DOCTOR] no SARA-owned services to stop");
    return;
  }
  for (const pid of pids) {
    if (String(pid) === String(process.pid)) continue;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
      console.log(`[SARA][DOCTOR] stopped PID ${pid}`);
    } catch (error: any) {
      console.warn(`[SARA][DOCTOR] could not stop PID ${pid}: ${error?.message || String(error)}`);
    }
  }
}

async function restartServices(): Promise<void> {
  stopServices();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log("[SARA][DOCTOR] restarting SARA production startup");
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "start:prod"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    env: { ...process.env },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function main(): Promise<void> {
  if (mode === "--status") {
    await reportStatus();
    return;
  }
  if (mode === "--stop") {
    stopServices();
    return;
  }
  if (mode === "--restart") {
    await restartServices();
    return;
  }

  await reportStatus();
  console.log("[SARA][DOCTOR] healthy services are acceptable; no forced action taken.");
}

main().catch((error: any) => {
  console.error("[SARA][DOCTOR] failed:", error?.message || String(error));
  process.exit(1);
});
