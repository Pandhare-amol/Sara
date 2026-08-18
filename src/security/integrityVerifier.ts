import fs from "fs";
import path from "path";
import crypto from "crypto";
import { verifyIntegrity, loadIntegrityManifest, IntegrityManifest } from "./integrityMonitor.js";

const KEY_RELATIVE = path.join("data", "security", ".manifest-key");
const MANIFEST_RELATIVE = path.join("data", "security", "integrity-manifest.json");

export type IntegrityState = "TRUSTED" | "MODIFIED" | "MISSING" | "UNEXPECTED" | "INVALID_BASELINE";

export interface IntegrityResult {
  ok: boolean;
  state: IntegrityState;
  mode: "development" | "production";
  signature_ok?: boolean;
  stale?: boolean;
  files_checked: number;
  files_failed: number;
  failures: { file: string; expected: string; actual?: string }[];
  reason?: string;
}

export function isManifestStale(manifest: IntegrityManifest | null, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  if (!manifest || !manifest.createdAt) return false;
  const createdAt = new Date(manifest.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt > maxAgeMs;
}

function deepSort(obj: any): any {
  if (Array.isArray(obj)) return obj.map(deepSort);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj).sort().reduce((acc: any, k) => {
      acc[k] = deepSort(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

function computeHmac(manifestObj: object, key: string): string {
  const { signature: _sig, signed_at: _sat, ...rest } = manifestObj as any;
  const canonical = JSON.stringify(deepSort(rest));
  return crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

function loadKey(projectRoot: string): string | null {
  const keyFile = path.join(projectRoot, KEY_RELATIVE);
  try {
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, "utf8").trim();
      if (raw.length >= 32) return raw;
    }
  } catch {}
  return null;
}

export function runIntegrityCheck(projectRoot: string): IntegrityResult {
  const isDev = process.env.DEVELOPMENT_MODE === "true" || process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (isDev) {
    return {
      ok: true,
      state: "TRUSTED",
      mode: "development",
      files_checked: 0,
      files_failed: 0,
      failures: [],
      reason: "Development mode — integrity check skipped",
    };
  }

  const manifestPath = path.join(projectRoot, MANIFEST_RELATIVE);
  const manifest = loadIntegrityManifest(manifestPath);
  if (!manifest) {
    return {
      ok: false,
      state: "INVALID_BASELINE",
      mode: "production",
      signature_ok: undefined,
      stale: false,
      files_checked: 0,
      files_failed: 0,
      failures: [],
      reason: "INTEGRITY BASELINE INVALID: manifest missing",
    };
  }

  const staleManifest = isManifestStale(manifest);
  const key = loadKey(projectRoot);
  let signatureOk: boolean | undefined;
  if (key && manifest.signature) {
    const expected = computeHmac(manifest, key);
    signatureOk = expected === manifest.signature;
    if (!signatureOk) {
      return {
        ok: false,
        state: "INVALID_BASELINE",
        mode: "production",
        signature_ok: false,
        stale: staleManifest,
        files_checked: 0,
        files_failed: 0,
        failures: [],
        reason: "INTEGRITY BASELINE INVALID: manifest signature mismatch",
      };
    }
  } else if (key === null && manifest.signature) {
    return {
      ok: false,
      state: "INVALID_BASELINE",
      mode: "production",
      signature_ok: undefined,
      stale: staleManifest,
      files_checked: 0,
      files_failed: 0,
      failures: [],
      reason: "INTEGRITY BASELINE INVALID: manifest signing key missing",
    };
  }

  const results = verifyIntegrity(projectRoot, manifest);
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    recordIntegrityFailure(projectRoot, {
      type: "file_hash_mismatch",
      failures: failures.map((f) => ({ file: f.file, expected: f.expected, actual: f.actual ?? null })),
      timestamp: new Date().toISOString(),
    });
    if (failures.length > 0) {
      console.error(`[Integrity] MODIFIED files:`);
      for (const f of failures) {
        console.error(`  file=${f.file}`);
        console.error(`  expected=${f.expected}`);
        console.error(`  actual=${f.actual ?? 'MISSING'}`);
      }
    }
    return {
      ok: false,
      state: failures.some((f) => !f.actual) ? "MISSING" : "MODIFIED",
      mode: "production",
      signature_ok: signatureOk,
      stale: staleManifest,
      files_checked: results.length,
      files_failed: failures.length,
      failures: failures.map((f) => ({ file: f.file, expected: f.expected, actual: f.actual })),
      reason: staleManifest ? "INTEGRITY BASELINE INVALID: trusted baseline is stale" : "Integrity check failed",
    };
  }

  return {
    ok: true,
    state: "TRUSTED",
    mode: "production",
    signature_ok: signatureOk,
    stale: staleManifest,
    files_checked: results.length,
    files_failed: 0,
    failures: [],
    reason: staleManifest ? "Trusted baseline is stale but verified" : undefined,
  };
}

function recordIntegrityFailure(projectRoot: string, record: object): void {
  try {
    const logDir = path.join(projectRoot, "data", "security", "integrity-failures");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `failure-${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify(record, null, 2));
  } catch {}
}
