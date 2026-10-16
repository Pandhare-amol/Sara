import fs from "node:fs/promises";
import path from "node:path";
import { dataFile } from "../server_paths";
import type { EvaluationReport } from "../src/core/evaluation/agentEvaluation";
import { reviewCandidateEvaluation } from "../src/core/evaluation/reviewCandidate";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("Usage: npm run review:agent-eval -- <baseline-report.json> <candidate-report.json>");
  process.exitCode = 2;
} else {
  const read = async (file: string): Promise<EvaluationReport> => {
    const stat = await fs.stat(file);
    if (stat.size > 1_000_000) throw new Error("Evaluation report exceeds the size limit.");
    return JSON.parse(await fs.readFile(file, "utf8")) as EvaluationReport;
  };
  try {
    const verdict = reviewCandidateEvaluation(await read(baselinePath), await read(candidatePath));
    const report = dataFile("evaluation/last-review.json");
    await fs.mkdir(path.dirname(report), { recursive: true, mode: 0o700 });
    const temp = `${report}.${process.pid}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(verdict, null, 2), { mode: 0o600 }); await fs.rename(temp, report); }
    finally { await fs.rm(temp, { force: true }); }
    console.log(`Offline comparison: ${verdict.status}; baseline ${verdict.baselinePassed}, candidate ${verdict.candidatePassed}.`);
    for (const reason of verdict.reasons) console.log(`- ${reason}`);
    console.log(`Human code/security review is always required. No code changed or deployed. Report: ${report}`);
    if (verdict.status === "rejected") process.exitCode = 1;
  } catch (error) {
    console.error(`Evaluation comparison failed: ${error instanceof Error ? error.name : "Invalid report"}.`);
    process.exitCode = 2;
  }
}
