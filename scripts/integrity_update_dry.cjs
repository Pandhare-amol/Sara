#!/usr/bin/env node
/**
 * SARA Integrity Dry-Run — integrity:update:dry
 *
 * Shows exactly which protected files have changed (old hash vs new hash)
 * WITHOUT modifying the manifest, source files, or tests.
 *
 * Usage:
 *   node scripts/integrity_update_dry.cjs
 *   npm run integrity:update:dry
 *
 * Exit codes:
 *   0 — all files match the trusted manifest (no changes needed)
 *   1 — one or more files differ from the trusted manifest
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = process.cwd();
const MANIFEST_PATH = path.join(projectRoot, "data", "security", "integrity-manifest.json");
const KEY_PATH = path.join(projectRoot, "data", "security", ".manifest-key");

// ── Utilities ────────────────────────────────────────────────────────────────

function sha256File(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function deepSort(obj) {
  if (Array.isArray(obj)) return obj.map(deepSort);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = deepSort(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

function computeHmac(manifestObj, key) {
  const { signature: _sig, signed_at: _sat, ...rest } = manifestObj;
  const canonical = JSON.stringify(deepSort(rest));
  return crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

// ── Load manifest ────────────────────────────────────────────────────────────

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error("[SARA][DRY-RUN] ERROR: Integrity manifest not found:", MANIFEST_PATH);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch (e) {
  console.error("[SARA][DRY-RUN] ERROR: Failed to parse manifest:", e.message);
  process.exit(1);
}

if (!Array.isArray(manifest.files)) {
  console.error("[SARA][DRY-RUN] ERROR: Manifest has no files array.");
  process.exit(1);
}

// ── Verify HMAC signature ────────────────────────────────────────────────────

if (fs.existsSync(KEY_PATH)) {
  const key = fs.readFileSync(KEY_PATH, "utf8").trim();
  if (manifest.signature) {
    const expected = computeHmac(manifest, key);
    if (expected !== manifest.signature) {
      console.warn("[SARA][DRY-RUN] WARNING: Manifest HMAC signature mismatch — manifest may have been tampered.");
    } else {
      console.log("[SARA][DRY-RUN] Manifest HMAC signature: VALID");
    }
  } else {
    console.warn("[SARA][DRY-RUN] WARNING: Manifest has no signature field.");
  }
} else {
  console.warn("[SARA][DRY-RUN] WARNING: Signing key not found — cannot verify HMAC signature.");
}

// ── Compare actual file hashes ───────────────────────────────────────────────

console.log(`\n[SARA][DRY-RUN] Comparing ${manifest.files.length} protected files against actual disk state...`);
console.log("[SARA][DRY-RUN] NOTE: This does NOT modify any file.\n");

const changed = [];
const missing = [];
const matched = [];

for (const entry of manifest.files) {
  const relPath = String(entry.file || "").replace(/\\/g, "/");
  const absPath = path.join(projectRoot, relPath);
  if (!fs.existsSync(absPath)) {
    missing.push({ file: relPath, expected: entry.hash });
    continue;
  }
  const actual = sha256File(absPath);
  if (actual === entry.hash) {
    matched.push(relPath);
  } else {
    changed.push({ file: relPath, old_hash: entry.hash, new_hash: actual });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (changed.length === 0 && missing.length === 0) {
  console.log(`[SARA][DRY-RUN] ✅ All ${matched.length} protected files MATCH the trusted manifest.`);
  console.log("[SARA][DRY-RUN] No baseline update is needed.");
  process.exit(0);
}

console.log(`[SARA][DRY-RUN] ────────────────────────────────────────────────`);
console.log(`[SARA][DRY-RUN] SUMMARY: ${changed.length} MODIFIED, ${missing.length} MISSING, ${matched.length} MATCHED`);
console.log(`[SARA][DRY-RUN] ────────────────────────────────────────────────\n`);

if (changed.length > 0) {
  console.log(`[SARA][DRY-RUN] MODIFIED FILES (${changed.length}):`);
  for (const item of changed) {
    console.log(`  FILE:     ${item.file}`);
    console.log(`  OLD HASH: ${item.old_hash}`);
    console.log(`  NEW HASH: ${item.new_hash}`);
    console.log();
  }
}

if (missing.length > 0) {
  console.log(`[SARA][DRY-RUN] MISSING FILES (${missing.length}):`);
  for (const item of missing) {
    console.log(`  FILE:     ${item.file}`);
    console.log(`  EXPECTED: ${item.expected}`);
    console.log();
  }
}

console.log("[SARA][DRY-RUN] To update the trusted baseline, run:");
console.log("  npm run integrity:update");
console.log();
console.log("[SARA][DRY-RUN] IMPORTANT: Only run integrity:update after explicitly");
console.log("[SARA][DRY-RUN] reviewing and authorizing ALL changes listed above.");

process.exit(1);
