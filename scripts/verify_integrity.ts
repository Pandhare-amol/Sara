import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIntegrityCheck } from "../src/security/integrityVerifier.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = runIntegrityCheck(projectRoot);

console.log(`[SARA][INTEGRITY] state=${result.state} ok=${result.ok} mode=${result.mode}`);
if (result.reason) {
  console.log(`[SARA][INTEGRITY] reason=${result.reason}`);
}
if (result.failures.length > 0) {
  for (const failure of result.failures.slice(0, 20)) {
    console.log(`[SARA][INTEGRITY] FILE: ${failure.file}`);
    console.log(`  EXPECTED: ${failure.expected}`);
    if (failure.actual) console.log(`  ACTUAL:   ${failure.actual}`);
  }
}

if (!result.ok) {
  process.exit(1);
}

console.log(`[SARA][INTEGRITY] verified ${result.files_checked} protected files successfully.`);
