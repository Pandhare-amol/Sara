import fs from "node:fs/promises";
import path from "node:path";

export interface QualityReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
  analyzedAt: string;
}

export class MusicQualityAnalyzer {
  async verifyArtifact(filePath: string, expectedDurationSeconds?: number): Promise<QualityReport> {
    const checks: QualityReport["checks"] = [];
    try {
      const stat = await fs.stat(filePath);
      checks.push({ name: "file_exists", passed: stat.isFile() && stat.size > 44, details: `${stat.size} bytes` });
      const header = Buffer.alloc(12);
      const handle = await fs.open(filePath, "r");
      await handle.read(header, 0, 12, 0);
      await handle.close();
      const isWav = header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
      checks.push({ name: "decodable_container", passed: isWav, details: isWav ? "RIFF/WAVE header found" : "Unsupported or corrupt container" });
      if (expectedDurationSeconds !== undefined) checks.push({ name: "duration_available", passed: expectedDurationSeconds > 0, details: `${expectedDurationSeconds}s` });
    } catch (error) {
      checks.push({ name: "artifact_readable", passed: false, details: error instanceof Error ? error.message : String(error) });
    }
    return { passed: checks.length > 0 && checks.every((check) => check.passed), checks, analyzedAt: new Date().toISOString() };
  }

  async verifyProjectAsset(projectId: string, assetPath: string): Promise<QualityReport> {
    const resolved = path.resolve(assetPath);
    const expectedRoot = path.resolve(process.cwd(), "data", "projects", projectId);
    if (!resolved.startsWith(expectedRoot + path.sep)) return { passed: false, checks: [{ name: "asset_scope", passed: false, details: "Asset is outside the project directory." }], analyzedAt: new Date().toISOString() };
    return this.verifyArtifact(resolved);
  }
}