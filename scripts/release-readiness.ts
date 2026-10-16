import { execFileSync } from "node:child_process";
import { trackedArtifactCounts } from "../src/security/trackedReleaseScan";

try {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 20_000_000 })
    .split("\0").filter(Boolean);
  const summary = trackedArtifactCounts(tracked);
  console.log(JSON.stringify({ check: "tracked-runtime-artifacts", ...summary,
    status: summary.total ? "BLOCKED" : "PASS",
    action: summary.total ? "Owner-led credential/history review and non-destructive Git deindexing required; this command changes no files." :
      "Tracked runtime-path gate passed. Continue full tests, live providers and platform-specific reviews." }, null, 2));
  if (summary.total) process.exitCode = 1;
} catch {
  console.error("Release readiness could not inspect tracked paths; release blocked.");
  process.exitCode = 2;
}
