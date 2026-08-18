import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ============================================================
// SARA Startup Config Validator
// Validates required environment and configuration before startup.
// Never exposes secrets to the frontend.
// ============================================================

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ServiceConfig {
  backendPort: number;
  agentPort: number;
  frontendPort: number;
  projectRoot: string;
  pythonExe: string;
  nodeExe: string;
  autoStart: boolean;
  developmentMode: boolean;
}

const REQUIRED_ENV = ["GEMINI_API_KEY"];

/**
 * Find the best Python interpreter available.
 * Prefers the local venv, then searches PATH.
 */
export function findPythonExe(projectRoot: string): string {
  const candidates = [
    path.join(projectRoot, ".venv-1", "Scripts", "python.exe"),
    path.join(projectRoot, ".venv", "Scripts", "python.exe"),
    path.join(projectRoot, ".venv", "bin", "python"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH
  try {
    const which = execSync("where python", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")[0]
      .trim();
    if (which && fs.existsSync(which)) return which;
  } catch {}
  try {
    const which3 = execSync("where python3", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")[0]
      .trim();
    if (which3 && fs.existsSync(which3)) return which3;
  } catch {}
  return "python"; // fallback — may fail at runtime
}

/**
 * Check whether a TCP port is already in use.
 * Uses `netstat` on Windows.
 */
export function isPortInUse(port: number): boolean {
  try {
    const out = execSync(`netstat -ano -p TCP`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.split("\n").some((line) => {
      const m = line.match(/:(\d+)\s+\S+\s+LISTEN/);
      return m && parseInt(m[1], 10) === port;
    });
  } catch {
    return false;
  }
}

/**
 * Load the SARA .env file into process.env.
 * Does NOT load secrets — those remain in process.env only.
 */
export function loadEnvFile(projectRoot: string): void {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {}
}

/**
 * Validate configuration and environment.
 * Returns errors and warnings — never prints secrets.
 */
export function validateConfig(projectRoot: string): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Load .env
  loadEnvFile(projectRoot);

  // Check required env vars
  for (const key of REQUIRED_ENV) {
    if (!process.env[key] || process.env[key]!.trim() === "") {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // Check Node.js version
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    errors.push(`Node.js >= 18 is required (found v${process.versions.node})`);
  }

  // Check Python
  const pyExe = findPythonExe(projectRoot);
  try {
    const pyVer = execSync(`"${pyExe}" --version`, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
    const pyMatch = pyVer.match(/(\d+)\.(\d+)/);
    if (pyMatch) {
      const pyMaj = parseInt(pyMatch[1], 10);
      const pyMin = parseInt(pyMatch[2], 10);
      if (pyMaj < 3 || (pyMaj === 3 && pyMin < 11)) {
        warnings.push(`Python 3.11+ recommended (found ${pyVer})`);
      }
    }
  } catch {
    errors.push(`Python interpreter not found. Expected at: ${pyExe}`);
  }

  // Check for uvicorn
  try {
    execSync(`"${pyExe}" -m uvicorn --version`, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    errors.push("uvicorn not found in Python environment. Install with: pip install uvicorn");
  }

  // Check desktop agent entry
  const agentMain = path.join(projectRoot, "desktop_agent", "main.py");
  if (!fs.existsSync(agentMain)) {
    errors.push(`Desktop agent not found at: desktop_agent/main.py`);
  }

  // Check npm
  try {
    execSync("npm --version", { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    errors.push("npm not found on PATH");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Build the ServiceConfig from environment and project layout.
 */
export function buildServiceConfig(projectRoot: string): ServiceConfig {
  loadEnvFile(projectRoot);
  return {
    backendPort: parseInt(process.env.SARA_BACKEND_PORT || "3000", 10),
    agentPort: parseInt(process.env.SARA_AGENT_PORT || "8765", 10),
    frontendPort: parseInt(process.env.SARA_FRONTEND_PORT || "3000", 10),
    projectRoot,
    pythonExe: findPythonExe(projectRoot),
    nodeExe: process.execPath,
    autoStart: process.env.AUTO_START === "true",
    developmentMode:
      process.env.DEVELOPMENT_MODE === "true" || process.env.NODE_ENV === "development",
  };
}
