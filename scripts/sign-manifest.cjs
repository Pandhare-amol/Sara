/**
 * SARA Manifest Signer (CJS)
 *
 * Signs an integrity manifest with an HMAC-SHA256 key.
 * The key is stored OUTSIDE of source control, in data/security/.manifest-key.
 * The private key is never bundled into the application.
 *
 * Usage:
 *   node scripts/sign-manifest.cjs <manifest-path> [--keygen]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY_RELATIVE = path.join("data", "security", ".manifest-key");

/**
 * Load or generate the HMAC key stored outside source.
 * The file is gitignored — do NOT commit it.
 */
function loadOrCreateKey(projectRoot) {
  const keyFile = path.join(projectRoot, KEY_RELATIVE);
  try {
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, "utf8").trim();
      if (raw.length >= 32) return raw;
    }
  } catch {}

  // Generate a new 256-bit hex key
  const newKey = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, newKey, { mode: 0o600 }); // owner read-only
    console.log(`[sign-manifest] Generated new signing key at: ${keyFile}`);
    console.log(`[sign-manifest] IMPORTANT: Keep this file safe and do NOT commit it.`);
  } catch (e) {
    console.error("[sign-manifest] Could not persist signing key:", e.message);
  }
  return newKey;
}

/**
 * Recursively sort object keys (deep canonical form) for stable HMAC input.
 */
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

/**
 * Compute HMAC-SHA256 over the canonical manifest JSON (without the signature field).
 */
function computeHmac(manifestObj, key) {
  // Remove signature and signed_at before hashing to allow re-signing
  const { signature: _sig, signed_at: _sat, ...rest } = manifestObj;
  const canonical = JSON.stringify(deepSort(rest));
  return crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

/**
 * Sign a manifest file in-place.
 * Reads the manifest JSON, appends a `signature` field, and writes it back.
 */
function signManifest(manifestPath, projectRoot) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`[sign-manifest] Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const key = loadOrCreateKey(projectRoot);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error("[sign-manifest] Failed to parse manifest:", e.message);
    process.exit(1);
  }

  manifest.signature = computeHmac(manifest, key);
  manifest.signed_at = new Date().toISOString();

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[sign-manifest] Signed manifest: ${manifestPath}`);
  console.log(`[sign-manifest] Signature: ${manifest.signature.slice(0, 16)}...`);
  return manifest;
}

/**
 * Verify a manifest file.
 * Returns true if the signature matches, false otherwise.
 */
function verifyManifest(manifestPath, projectRoot) {
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: "Manifest file not found" };

  const keyFile = path.join(projectRoot, KEY_RELATIVE);
  if (!fs.existsSync(keyFile)) {
    return { ok: false, reason: "Signing key not found — cannot verify" };
  }

  const key = fs.readFileSync(keyFile, "utf8").trim();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `Manifest parse error: ${e.message}` };
  }

  if (!manifest.signature) return { ok: false, reason: "Manifest has no signature" };

  const expected = computeHmac(manifest, key);
  const ok = expected === manifest.signature;
  return { ok, reason: ok ? "OK" : "Signature mismatch — manifest may have been tampered" };
}

// CLI entry
if (require.main === module) {
  const projectRoot = process.cwd();
  const args = process.argv.slice(2);
  const manifestPath = args[0];

  if (!manifestPath) {
    console.error("Usage: node scripts/sign-manifest.cjs <manifest-path>");
    process.exit(1);
  }

  signManifest(manifestPath, projectRoot);
}

module.exports = { signManifest, verifyManifest, loadOrCreateKey, computeHmac };
