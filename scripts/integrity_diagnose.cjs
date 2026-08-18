"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "data", "security", "integrity-manifest.json");
const KEY_PATH = path.join(PROJECT_ROOT, "data", "security", ".manifest-key");

function sha256File(filePath) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
  catch { return null; }
}
function deepSortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  if (obj !== null && typeof obj === "object") {
    const s = {};
    for (const k of Object.keys(obj).sort()) s[k] = deepSortKeys(obj[k]);
    return s;
  }
  return obj;
}
function computeHmac(manifest, key) {
  const { signature: _s, signed_at: _a, ...rest } = manifest;
  return crypto.createHmac("sha256", key).update(JSON.stringify(deepSortKeys(rest))).digest("hex");
}
function loadKey() {
  try { const r = fs.readFileSync(KEY_PATH, "utf8").trim(); return r.length >= 32 ? r : null; }
  catch { return null; }
}
function hr(n) { return "=".repeat(n || 60); }

console.log("\n" + hr());
console.log("  SARA Integrity Diagnostic Report");
console.log("  " + new Date().toISOString());
console.log(hr() + "\n");

const manifestExists = fs.existsSync(MANIFEST_PATH);
console.log("-- Manifest --");
console.log("  Path   : " + MANIFEST_PATH);
console.log("  Present: " + (manifestExists ? "YES" : "NO - WARNING"));
if (!manifestExists) { console.log("\n  Run: npm run integrity:update\n"); process.exit(0); }

let manifest;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")); }
catch { console.log("  Invalid JSON. Run: npm run integrity:update"); process.exit(0); }

console.log("  Version  : " + (manifest.manifestVersion || "unknown"));
console.log("  SARA Ver : " + (manifest.saraVersion || "unknown"));
console.log("  Build ID : " + (manifest.buildId || "unknown"));
console.log("  Created  : " + (manifest.createdAt || "unknown"));
console.log("  Algorithm: " + (manifest.algorithm || "unknown"));
const fileCount = Array.isArray(manifest.files) ? manifest.files.length : 0;
console.log("  Files    : " + fileCount + "\n");

const keyExists = fs.existsSync(KEY_PATH);
const key = loadKey();
console.log("-- Signing Key --");
console.log("  Path   : " + KEY_PATH);
console.log("  Present: " + (keyExists ? "YES" : "NO - WARNING"));
if (!key) console.log("  WARNING: Key missing or too short.\n");
else console.log();

console.log("-- HMAC Signature --");
if (!key) { console.log("  SKIP - key unavailable.\n"); }
else if (!manifest.signature) { console.log("  WARNING: No signature field.\n"); }
else {
  const expected = computeHmac(manifest, key);
  const ok = expected === manifest.signature;
  console.log("  Result : " + (ok ? "VALID" : "INVALID - WARNING"));
  if (!ok) {
    console.log("  Expected (16): " + expected.slice(0, 16) + "...");
    console.log("  Stored   (16): " + manifest.signature.slice(0, 16) + "...");
  }
  console.log();
}

console.log("-- File Integrity --");
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  console.log("  WARNING: No files in manifest.\n");
} else {
  const matched = [], changed = [], missing = [];
  for (const entry of manifest.files) {
    const absPath = path.resolve(PROJECT_ROOT, entry.file);
    const actual = sha256File(absPath);
    if (actual === null) missing.push({ file: entry.file, expected: entry.hash });
    else if (actual !== entry.hash) changed.push({ file: entry.file, expected: entry.hash, actual });
    else matched.push(entry.file);
  }
  console.log("  Matched : " + matched.length);
  console.log("  Changed : " + changed.length + (changed.length > 0 ? " - WARNING" : ""));
  console.log("  Missing : " + missing.length + (missing.length > 0 ? " - WARNING" : "") + "\n");
  if (changed.length > 0) {
    console.log("  Changed files:");
    for (const f of changed) {
      console.log("    " + f.file);
      console.log("      Expected: " + f.expected);
      console.log("      Actual  : " + f.actual);
    }
    console.log();
  }
  if (missing.length > 0) {
    console.log("  Missing files:");
    for (const f of missing) console.log("    " + f.file + " (expected: " + f.expected + ")");
    console.log();
  }
  const allOk = changed.length === 0 && missing.length === 0;
  console.log("-- Summary --");
  if (allOk) {
    console.log("  OK - All files match the trusted baseline. Integrity: TRUSTED");
  } else {
    console.log("  FAIL - Integrity: NOT TRUSTED");
    if (changed.length > 0) {
      console.log("  To review/accept: npm run integrity:update:dry  then  npm run integrity:update");
    }
    if (missing.length > 0) console.log("  Missing files must be restored or removed from the manifest.");
  }
}
console.log("\n" + hr() + "\n");
process.exit(0);