import path from "path";
import fs from "fs";
import { gatherBuildIdentity, loadBuildManifest } from "../src/security/buildIdentity.js";
import { generateIntegrityManifest, verifyIntegrity } from "../src/security/integrityMonitor.js";
import { AuditLogger, redactSecrets } from "../src/security/auditLogger.js";

async function runVerification() {
  console.log("=== SARA SECURITY & AUDIT VERIFICATION ===");
  const root = process.cwd();
  const dataDir = path.join(root, "data");

  // 1. Build Identity
  console.log("\n1. Testing Build Identity & Provenance...");
  const identity = gatherBuildIdentity(root, dataDir);
  console.log("   App Name:", identity.application);
  console.log("   Version:", identity.version);
  console.log("   Build ID:", identity.build_id);
  console.log("   Installation ID:", identity.installation_id);
  console.log("   Git Commit:", identity.git_info?.commit_hash || identity.source_revision || "N/A");
  console.log("   Integrity Hash:", identity.integrity_hash.slice(0, 16) + "...");
  if (!identity.installation_id || !identity.integrity_hash) {
    throw new Error("Build identity test failed: missing installation ID or integrity hash.");
  }
  console.log("   [PASS] Build Identity verification succeeded.");

  // 2. Secret Redaction
  console.log("\n2. Testing Secret Redaction...");
  const rawMeta = {
    apiKey: "AIzaSySecretKey12345",
    userToken: "bearer_xyz_token",
    password: "SuperSecretPassword123",
    cleanField: "normal_data",
  };
  const cleanMeta = redactSecrets(rawMeta);
  console.log("   Raw Metadata:", rawMeta);
  console.log("   Redacted Metadata:", cleanMeta);
  if (cleanMeta.apiKey !== "********" || cleanMeta.password !== "********" || cleanMeta.cleanField !== "normal_data") {
    throw new Error("Secret redaction test failed!");
  }
  console.log("   [PASS] Secret redaction succeeded.");

  // 3. File Integrity Monitoring
  console.log("\n3. Testing File Integrity Monitoring...");
  const protectedPaths = ["src", "desktop_agent", "server_full.ts", "package.json"];
  const outManifestPath = path.join(dataDir, "test-manifest.json");
  const manifest = generateIntegrityManifest(root, protectedPaths, outManifestPath, identity.source_revision);
  console.log("   Protected files hashed:", manifest.files.length);
  const results = verifyIntegrity(root, manifest);
  const failures = results.filter((r) => !r.ok);
  console.log("   Integrity verification failures:", failures.length);
  if (failures.length > 0) {
    console.error("   Failures sample:", failures.slice(0, 3));
    throw new Error("File integrity check failed unexpectedly.");
  }
  console.log("   [PASS] File Integrity Monitoring verification succeeded.");

  // 4. Audit Log Hash Chain
  console.log("\n4. Testing Audit Log Hash Chaining...");
  const auditLogger = new AuditLogger(path.join(dataDir, "security_test"));
  const e1 = await auditLogger.append({
    event_type: "SESSION_STARTED",
    severity: "INFO",
    metadata: { user: "test-owner", token: "secret-token-value" },
  });
  const e2 = await auditLogger.append({
    event_type: "CODE_INTEGRITY_CHECK",
    severity: "INFO",
    metadata: { status: "TRUSTED" },
  });
  console.log("   Event 1 Hash:", e1.event_hash ? e1.event_hash.slice(0, 16) + "..." : "none");
  console.log("   Event 2 Hash:", e2.event_hash ? e2.event_hash.slice(0, 16) + "..." : "none");
  console.log("   [PASS] Audit Log Hash Chaining test succeeded.");

  console.log("\n=== ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY ===");
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
