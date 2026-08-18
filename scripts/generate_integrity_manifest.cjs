"use strict";
/**
 * Generate & sign the SARA integrity manifest.
 *
 * 1. Walks protected paths, computes SHA-256 of each file.
 * 2. Writes manifest to data/security/integrity-manifest.json.
 * 3. Signs the manifest with the HMAC key from data/security/.manifest-key.
 *
 * Usage:
 *   node scripts/generate_integrity_manifest.js [protected-paths.json]
 */

const path = require("path");
const fs = require("fs");

// Prefer the compiled CJS build; fall back to ts-node if available
let generateIntegrityManifest;
try {
  ({ generateIntegrityManifest } = require("../dist/security/integrityMonitor.cjs"));
} catch {
  // Fallback: require the .js shim if it exists (built by tsc --outDir dist)
  try {
    ({ generateIntegrityManifest } = require("../src/security/integrityMonitor.ts"));
  } catch {
    // Pure JS fallback (no TypeScript transform needed at runtime)
    const crypto = require("crypto");
    const EXCLUDED_PATTERNS = [
      /__pycache__/, /\.pyc$/, /\.git/, /node_modules/, /dist/, /data/, /logs/,
      /\.tmp$/, /\.log$/, /sara_memory\.db$/, /data\.db$/, /sessions\.json$/,
      /memories\.json$/, /conversations.*\.json$/, /tool_calls\.json$/,
      /settings\.json$/, /build-manifest\.json$/, /trusted-manifest\.json$/,
      /generated-manifest\.json$/, /integrity-manifest\.json$/,
    ];
    function shouldExclude(rel) {
      const norm = rel.replace(/\\/g, "/");
      return EXCLUDED_PATTERNS.some(p => p.test(norm));
    }
    function sha256File(p) {
      const h = crypto.createHash("sha256");
      h.update(fs.readFileSync(p));
      return h.digest("hex");
    }
    generateIntegrityManifest = function(root, protectedPaths, outFile) {
      const files = [];
      function walk(dir) {
        fs.readdirSync(dir).forEach(name => {
          const fp = path.join(dir, name);
          const rel = path.relative(root, fp);
          if (shouldExclude(rel)) return;
          const s = fs.statSync(fp);
          if (s.isFile()) files.push({ file: rel, hash: sha256File(fp) });
          else if (s.isDirectory()) walk(fp);
        });
      }
      protectedPaths.forEach(p => {
        const abs = path.isAbsolute(p) ? p : path.join(root, p);
        if (!fs.existsSync(abs)) return;
        const s = fs.statSync(abs);
        if (s.isFile()) {
          const rel = path.relative(root, abs);
          if (!shouldExclude(rel)) files.push({ file: rel, hash: sha256File(abs) });
        } else if (s.isDirectory()) {
          walk(abs);
        }
      });
      const manifest = { files, generated_at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
      return manifest;
    };
  }
}

const { signManifest } = require("./sign-manifest.cjs");

const projectRoot = process.cwd();
const outDir = path.join(projectRoot, "data", "security");
try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
const outFile = path.join(outDir, "integrity-manifest.json");
const baselineMode = process.argv.includes("--baseline");

// Default protected paths; override by passing a JSON file path as first arg.
let protectedPaths = ["src", "server_full.ts", "desktop_agent", "startup"];
const pathArg = process.argv.slice(2).find((arg) => arg && !arg.startsWith("-"));
if (pathArg) {
  try {
    protectedPaths = JSON.parse(fs.readFileSync(pathArg, "utf8"));
  } catch (e) {
    console.error("Failed to parse paths file:", e.message);
  }
}

console.log("[SARA] Generating integrity manifest for:", protectedPaths);
const currentManifest = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
const tempOut = baselineMode ? path.join(outDir, "integrity-manifest.pending.json") : outFile;
const generated = generateIntegrityManifest(projectRoot, protectedPaths, tempOut);
generated.version = generated.version ?? 2;
generated.algorithm = generated.algorithm ?? "sha256";
generated.build_id = generated.build_id || process.env.SARA_BUILD_ID || "";
generated.created_at = generated.created_at || new Date().toISOString();

if (baselineMode) {
  console.log("[SARA] Integrity baseline update requested.");
  if (currentManifest && Array.isArray(currentManifest.files)) {
    const currentMap = new Map(currentManifest.files.map((f) => [f.file, f.hash]));
    const newMap = new Map(generated.files.map((f) => [f.file, f.hash]));
    const changed = [];
    for (const [file, hash] of newMap.entries()) {
      const prior = currentMap.get(file);
      if (prior !== hash) changed.push({ file, old_hash: prior || "(missing)", new_hash: hash });
    }
    for (const [file, hash] of currentMap.entries()) {
      if (!newMap.has(file)) changed.push({ file, old_hash: hash, new_hash: "(missing)" });
    }
    console.log(`[SARA] Protected files changed: ${changed.length}`);
    for (const item of changed.slice(0, 40)) {
      console.log(`[SARA]   ${item.file}`);
      console.log(`[SARA]     old: ${item.old_hash}`);
      console.log(`[SARA]     new: ${item.new_hash}`);
    }
  }
  let answer = "";
  if (process.argv.includes("--yes")) {
    answer = "y";
  } else {
    process.stdout.write("[SARA] Continue and trust this new baseline? [y/N] ");
    try {
      const buf = Buffer.alloc(32);
      const bytes = fs.readSync(0, buf, 0, buf.length, null);
      answer = buf.toString("utf8", 0, bytes).trim().toLowerCase();
    } catch {
      answer = "";
    }
  }
  if (!["y", "yes"].includes(answer)) {
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
    console.log("\n[SARA] Baseline update cancelled.");
    process.exit(1);
  }
  console.log("\n[SARA] Baseline accepted by explicit confirmation.");
  fs.writeFileSync(outFile, JSON.stringify(generated, null, 2));
  try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
} else {
  fs.writeFileSync(outFile, JSON.stringify(generated, null, 2));
}

console.log(`[SARA] Manifest written to ${outFile} (${generated.files.length} files)`);

// Sign the manifest with HMAC
signManifest(outFile, projectRoot);
console.log("[SARA] Manifest signed successfully.");
console.log("[SARA] Run SARA with DEVELOPMENT_MODE=false to enforce integrity checks.");
process.exit(0);
