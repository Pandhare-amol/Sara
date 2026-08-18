import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROJECT_ROOT = process.cwd();
const MANIFEST_PATH = path.join(PROJECT_ROOT, "data", "security", "integrity-manifest.json");

function sha256HexFile(p: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

console.log("INTEGRITY CHECK DIAGNOSTIC\n");
console.log(`Manifest files: ${manifest.files.length}`);
console.log("Checking for modified files...\n");

const failures: any[] = [];

for (const entry of manifest.files) {
  const fp = path.join(PROJECT_ROOT, entry.file);
  if (!fs.existsSync(fp)) {
    failures.push({
      file: entry.file,
      expected: entry.hash,
      actual: null,
      status: "MISSING"
    });
  } else {
    const actual = sha256HexFile(fp);
    if (actual !== entry.hash) {
      failures.push({
        file: entry.file,
        expected: entry.hash,
        actual: actual,
        status: "MODIFIED"
      });
    }
  }
}

console.log(`FAILED: ${failures.length} files\n`);
for (let i = 0; i < Math.min(10, failures.length); i++) {
  const f = failures[i];
  console.log(`${i + 1}. ${f.file}`);
  console.log(`   Expected: ${f.expected}`);
  console.log(`   Actual:   ${f.actual || "MISSING"}`);
  console.log(`   Status:   ${f.status}`);
  console.log("");
}

if (failures.length > 10) {
  console.log(`... and ${failures.length - 10} more files`);
}
