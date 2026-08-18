/**
 * SARA Integrity Baseline Manager
 *
 * Handles explicit, authorized baseline updates.
 * NEVER auto-updates during startup.
 *
 * Usage:
 *   npm run integrity:verify      - Check current baseline
 *   npm run integrity:update:dry  - Preview changes
 *   npm run integrity:update      - Create new trusted baseline
 *   npm run integrity:diagnose    - Detailed diagnostic report
 *
 * Created by: Mr Amol Pandhre & the SARA Team
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const SECURITY_DIR = path.join(DATA_DIR, "security");
const KEY_PATH = path.join(SECURITY_DIR, ".manifest-key");
const MANIFEST_PATH = path.join(SECURITY_DIR, "integrity-manifest.json");

// Protected source paths — must match integrityMonitor.ts
const PROTECTED_PATHS = [
  "src",
  "startup",
  "server.ts",
  "server_full.ts",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
];

const EXCLUDED_PATTERNS = [
  /__pycache__/,
  /\.pyc$/,
  /\.git/,
  /node_modules/,
  /dist/,
  /data/,
  /logs/,
  /\.tmp$/,
  /\.log$/,
  /sara_memory\.db$/,
  /data\.db$/,
  /sessions\.json$/,
  /memories\.json$/,
  /conversations.*\.json$/,
  /tool_calls\.json$/,
  /settings\.json$/,
  /build-manifest\.json$/,
  /trusted-manifest\.json$/,
  /generated-manifest\.json$/,
  /integrity-manifest\.json$/,
];

interface IntegrityManifest {
  manifestVersion: number;
  saraVersion: string;
  buildId: string;
  createdAt: string;
  algorithm: "sha256";
  projectRoot: string;
  files: { file: string; hash: string }[];
  signature?: string;
  signed_at?: string;
  source_revision?: string;
  generated_at?: string;
}

interface FileStatus {
  file: string;
  status: "TRUSTED" | "MODIFIED" | "MISSING" | "NEW";
  expectedHash?: string;
  actualHash?: string;
}

function log(msg: string): void {
  console.log(`[SARA][Integrity] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[SARA][Integrity] ERROR: ${msg}`);
}

function logWarn(msg: string): void {
  console.warn(`[SARA][Integrity] WARN: ${msg}`);
}

function normalizeRelativePath(relPath: string): string {
  return String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function shouldExclude(relPath: string): boolean {
  const norm = normalizeRelativePath(relPath);
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(norm));
}

function sha256HexFile(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function deepSort(obj: any): any {
  if (Array.isArray(obj)) return obj.map(deepSort);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc: any, k) => {
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

function loadOrCreateKey(): string {
  if (fs.existsSync(KEY_PATH)) {
    const raw = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (raw.length >= 32) return raw;
  }

  logError(`Manifest signing key missing: ${KEY_PATH}`);
  logError("Cannot proceed without trusted signing key.");
  logError("If baseline is lost, restore from backup or contact administrator.");
  process.exit(1);
}

function loadCurrentManifest(): IntegrityManifest | null {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed as IntegrityManifest;
  } catch (e) {
    logError(`Failed to load manifest: ${e}`);
    return null;
  }
}

function generateNewManifest(currentManifest: IntegrityManifest | null): IntegrityManifest {
  const files: { file: string; hash: string }[] = [];
  const seen = new Set<string>();
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );

  PROTECTED_PATHS.forEach((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
    if (!fs.existsSync(abs)) {
      logWarn(`Protected path not found: ${p}`);
      return;
    }

    const appendFile = (filePath: string) => {
      const rel = normalizeRelativePath(path.relative(PROJECT_ROOT, filePath));
      if (!rel || shouldExclude(rel) || seen.has(rel)) return;
      seen.add(rel);
      files.push({ file: rel, hash: sha256HexFile(filePath) });
    };

    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      appendFile(abs);
    } else if (stat.isDirectory()) {
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const fp = path.join(dir, name);
          const rel = normalizeRelativePath(path.relative(PROJECT_ROOT, fp));
          if (shouldExclude(rel)) continue;
          const s = fs.statSync(fp);
          if (s.isFile()) appendFile(fp);
          else if (s.isDirectory()) walk(fp);
        }
      };
      walk(abs);
    }
  });

  files.sort((a, b) => a.file.localeCompare(b.file));

  const manifest: IntegrityManifest = {
    manifestVersion: 1,
    saraVersion: packageJson.version || "1.0.0",
    buildId: process.env.SARA_BUILD_ID || "unknown",
    createdAt: new Date().toISOString(),
    algorithm: "sha256",
    projectRoot: path.resolve(PROJECT_ROOT),
    files,
    source_revision: process.env.SARA_SOURCE_REV,
    generated_at: new Date().toISOString(),
  };

  return manifest;
}

function signManifest(manifest: IntegrityManifest, key: string): IntegrityManifest {
  const copy = { ...manifest };
  const hmac = computeHmac(copy, key);
  return {
    ...copy,
    signature: hmac,
    signed_at: new Date().toISOString(),
  };
}

function verifyManifestSignature(manifest: IntegrityManifest, key: string): boolean {
  if (!manifest.signature) return false;
  const expected = computeHmac(manifest, key);
  return expected === manifest.signature;
}

function compareManifests(
  current: IntegrityManifest | null,
  newManifest: IntegrityManifest
): FileStatus[] {
  const currentMap = new Map(
    (current?.files || []).map((f) => [normalizeRelativePath(f.file), f.hash])
  );
  const newMap = new Map(
    newManifest.files.map((f) => [normalizeRelativePath(f.file), f.hash])
  );

  const results: FileStatus[] = [];

  // Check all new files
  for (const [file, hash] of newMap) {
    const oldHash = currentMap.get(file);
    if (!oldHash) {
      results.push({ file, status: "NEW", actualHash: hash });
    } else if (oldHash === hash) {
      results.push({ file, status: "TRUSTED", expectedHash: hash, actualHash: hash });
    } else {
      results.push({
        file,
        status: "MODIFIED",
        expectedHash: oldHash,
        actualHash: hash,
      });
    }
  }

  // Check for removed files
  for (const [file, hash] of currentMap) {
    if (!newMap.has(file)) {
      results.push({ file, status: "MISSING", expectedHash: hash });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────
// Command: verify
// ─────────────────────────────────────────────────────────────────

export async function cmdVerify(): Promise<number> {
  log("Verifying current baseline...");

  const manifest = loadCurrentManifest();
  if (!manifest) {
    logError("No baseline manifest found");
    return 1;
  }

  const key = loadOrCreateKey();
  const signatureOk = verifyManifestSignature(manifest, key);

  if (!signatureOk) {
    logError("Manifest signature invalid — baseline may have been tampered");
    return 1;
  }

  log(`Manifest valid (created ${manifest.createdAt})`);
  log(`Files in baseline: ${manifest.files.length}`);
  log(`Signature: VALID`);

  // Verify all files
  const fileStatuses = manifest.files.map((entry) => {
    const relFile = normalizeRelativePath(entry.file);
    const absFile = path.join(PROJECT_ROOT, relFile);

    if (!fs.existsSync(absFile)) {
      return { file: relFile, status: "MISSING" as const, expectedHash: entry.hash };
    }

    try {
      const actual = sha256HexFile(absFile);
      if (actual === entry.hash) {
        return {
          file: relFile,
          status: "TRUSTED" as const,
          expectedHash: entry.hash,
          actualHash: actual,
        };
      } else {
        return {
          file: relFile,
          status: "MODIFIED" as const,
          expectedHash: entry.hash,
          actualHash: actual,
        };
      }
    } catch {
      return { file: relFile, status: "MISSING" as const, expectedHash: entry.hash };
    }
  });

  const modified = fileStatuses.filter((f) => f.status !== "TRUSTED");
  const trusted = fileStatuses.filter((f) => f.status === "TRUSTED");

  log(`\nFile Status:`);
  log(`  TRUSTED:  ${trusted.length}`);
  log(`  MODIFIED: ${modified.filter((f) => f.status === "MODIFIED").length}`);
  log(`  MISSING:  ${modified.filter((f) => f.status === "MISSING").length}`);

  if (modified.length > 0) {
    log(`\nModified/Missing Files:`);
    for (const f of modified) {
      log(`  ${f.status}: ${f.file}`);
      if (f.status === "MODIFIED") {
        log(`    Expected: ${f.expectedHash}`);
        log(`    Actual:   ${f.actualHash}`);
      }
    }
    return 1;
  }

  log(`\nBaseline TRUSTED (all ${trusted.length} files verified)`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Command: update:dry
// ─────────────────────────────────────────────────────────────────

export async function cmdUpdateDry(): Promise<number> {
  log("Performing dry-run baseline update...");

  const current = loadCurrentManifest();
  const newManifest = generateNewManifest(current);
  const changes = compareManifests(current, newManifest);

  const modified = changes.filter((c) => c.status === "MODIFIED");
  const newFiles = changes.filter((c) => c.status === "NEW");
  const missing = changes.filter((c) => c.status === "MISSING");
  const trusted = changes.filter((c) => c.status === "TRUSTED");

  log(`\nComparison Summary:`);
  log(`  TRUSTED:  ${trusted.length}`);
  log(`  MODIFIED: ${modified.length}`);
  log(`  NEW:      ${newFiles.length}`);
  log(`  MISSING:  ${missing.length}`);

  if (modified.length > 0) {
    log(`\nModified Files:`);
    for (const f of modified) {
      log(`  ${f.file}`);
      log(`    Expected: ${f.expectedHash}`);
      log(`    Actual:   ${f.actualHash}`);
    }
  }

  if (newFiles.length > 0) {
    log(`\nNew Files:`);
    for (const f of newFiles) {
      log(`  ${f.file}`);
    }
  }

  if (missing.length > 0) {
    log(`\nRemoved Files:`);
    for (const f of missing) {
      log(`  ${f.file}`);
    }
  }

  log(`\nNo files modified during dry-run.`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Command: update
// ─────────────────────────────────────────────────────────────────

export async function cmdUpdate(): Promise<number> {
  log("Creating new trusted baseline...");

  // Step 1: Load key
  const key = loadOrCreateKey();
  log("Signing key loaded");

  // Step 2: Load current manifest
  const current = loadCurrentManifest();
  if (current) {
    log(`Previous baseline: ${current.createdAt}`);
  } else {
    log("No previous baseline found");
  }

  // Step 3: Generate new manifest
  log("Generating new manifest...");
  const newManifest = generateNewManifest(current);
  log(`Files in new baseline: ${newManifest.files.length}`);

  // Step 4: Sign manifest
  log("Signing manifest...");
  const signedManifest = signManifest(newManifest, key);

  // Step 5: Verify signature
  const sigOk = verifyManifestSignature(signedManifest, key);
  if (!sigOk) {
    logError("Signature verification failed after signing");
    return 1;
  }
  log("Signature verified");

  // Step 6: Write to temporary file
  fs.mkdirSync(SECURITY_DIR, { recursive: true });
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(signedManifest, null, 2));

  // Step 7: Atomic replace
  if (fs.existsSync(MANIFEST_PATH)) {
    const backupPath = `${MANIFEST_PATH}.bak`;
    fs.copyFileSync(MANIFEST_PATH, backupPath);
    log(`Backup created: ${backupPath}`);
  }

  fs.renameSync(tmpPath, MANIFEST_PATH);
  log(`Manifest written: ${MANIFEST_PATH}`);

  // Step 8: Reload and verify
  const reloaded = loadCurrentManifest();
  if (!reloaded) {
    logError("Failed to reload manifest after write");
    return 1;
  }

  const reloadSigOk = verifyManifestSignature(reloaded, key);
  if (!reloadSigOk) {
    logError("Signature verification failed after reload");
    return 1;
  }

  log(`\nBaseline successfully updated`);
  log(`  Version: ${reloaded.saraVersion}`);
  log(`  Files: ${reloaded.files.length}`);
  log(`  Created: ${reloaded.createdAt}`);
  log(`  Signature: VALID`);

  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Command: diagnose
// ─────────────────────────────────────────────────────────────────

export async function cmdDiagnose(): Promise<number> {
  log("Running diagnostic...\n");

  // Manifest
  log("Manifest:");
  if (fs.existsSync(MANIFEST_PATH)) {
    const stat = fs.statSync(MANIFEST_PATH);
    log(`  path: ${MANIFEST_PATH}`);
    log(`  exists: YES`);
    log(`  size: ${stat.size} bytes`);

    const manifest = loadCurrentManifest();
    if (manifest) {
      const key = fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, "utf8").trim() : null;
      const sigOk = key ? verifyManifestSignature(manifest, key) : undefined;
      log(`  signature: ${sigOk === true ? "VALID" : sigOk === false ? "INVALID" : "KEY_MISSING"}`);
      log(`  created: ${manifest.createdAt}`);
      log(`  files: ${manifest.files.length}`);
    } else {
      log(`  signature: UNREADABLE`);
    }
  } else {
    log(`  exists: NO`);
  }

  // Key
  log("\nKey:");
  if (fs.existsSync(KEY_PATH)) {
    const stat = fs.statSync(KEY_PATH);
    log(`  exists: YES`);
    log(`  size: ${stat.size} bytes`);
  } else {
    log(`  exists: NO`);
  }

  // Protected files
  log("\nProtected files:");
  const manifest = loadCurrentManifest();
  if (manifest) {
    const fileStatuses = manifest.files.map((entry) => {
      const relFile = normalizeRelativePath(entry.file);
      const absFile = path.join(PROJECT_ROOT, relFile);

      if (!fs.existsSync(absFile)) {
        return {
          file: relFile,
          status: "MISSING" as const,
          expectedHash: entry.hash,
        };
      }

      try {
        const actual = sha256HexFile(absFile);
        return {
          file: relFile,
          status: actual === entry.hash ? ("TRUSTED" as const) : ("MODIFIED" as const),
          expectedHash: entry.hash,
          actualHash: actual,
        };
      } catch {
        return { file: relFile, status: "ERROR" as const, expectedHash: entry.hash };
      }
    });

    const trusted = fileStatuses.filter((f) => f.status === "TRUSTED");
    const modified = fileStatuses.filter((f) => f.status === "MODIFIED");
    const missing = fileStatuses.filter((f) => f.status === "MISSING");

    log(`  checked: ${fileStatuses.length}`);
    log(`  trusted: ${trusted.length}`);
    log(`  modified: ${modified.length}`);
    log(`  missing: ${missing.length}`);

    if (modified.length > 0) {
      log(`\nModified Files:`);
      for (const f of modified) {
        log(`  ${f.file}`);
        log(`    Expected: ${f.expectedHash}`);
        log(`    Actual:   ${f.actualHash}`);
      }
    }

    if (missing.length > 0) {
      log(`\nMissing Files:`);
      for (const f of missing) {
        log(`  ${f.file}`);
      }
    }

    // Conclusion
    log(`\nConclusion:`);
    if (modified.length === 0 && missing.length === 0) {
      log(`  Status: BASELINE TRUSTED`);
    } else if (modified.length > 0 || missing.length > 0) {
      log(`  Status: CHANGES DETECTED`);
      log(`  Reason: ${modified.length} modified, ${missing.length} missing`);
      log(`  Action: Run 'npm run integrity:update' to create new baseline`);
    }
  } else {
    log(`  No manifest found`);
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "verify":
      process.exit(await cmdVerify());
    case "update:dry":
      process.exit(await cmdUpdateDry());
    case "update":
      process.exit(await cmdUpdate());
    case "diagnose":
      process.exit(await cmdDiagnose());
    default:
      console.log("Usage: tsx integrity.ts [verify|update:dry|update|diagnose]");
      process.exit(1);
  }
}

main().catch((e) => {
  logError(String(e));
  process.exit(1);
});
