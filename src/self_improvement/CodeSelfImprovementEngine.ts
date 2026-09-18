// src/self_improvement/CodeSelfImprovementEngine.ts
import { ModelIntegrationService } from "../services/ModelIntegrationService";
import simpleGit, { SimpleGit } from "simple-git";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Very simple self‑improvement engine.
 * It asks the active LLM to generate a patch based on a hard‑coded description,
 * checks that the patch applies cleanly, runs the project tests, and if everything
 * passes, commits the change on a dedicated branch.
 */
export class CodeSelfImprovementEngine {
  private readonly modelService = ModelIntegrationService.getInstance();
  private readonly git: SimpleGit = simpleGit();

  /** Description of what we want to improve – in a real system this would be dynamic. */
  private readonly improvementPrompt = "Refactor LLMService to cache responses and reduce latency.";

  /** Run a single improvement cycle. */
  public async runCycle(): Promise<void> {
    try {
      // 1. Generate a diff from the LLM.
      const diff = await this.modelService.generatePatch(this.improvementPrompt);
      if (!diff || diff.trim() === "") {
        console.warn("Self‑improvement: LLM returned empty diff.");
        return;
      }

      // 2. Write diff to a temporary file.
      const diffPath = "self_improvement.diff";
      await fs.writeFile(diffPath, diff);

      // 3. Verify the diff applies cleanly.
      await this.git.raw(["apply", "--check", diffPath]).catch((e) => {
        console.error("Patch does not apply cleanly:", e);
        throw e;
      });

      // 4. Run the project's test suite.
      const { stdout, stderr } = await execAsync("npm test", { cwd: process.cwd() });
      console.log(stdout);
      if (stderr) console.error(stderr);

      // If tests fail, abort.
      // (npm test exits with non‑zero code; execAsync would reject, caught above.)

      // 5. Apply the patch for real.
      await this.git.applyPatch(diffPath);
      await this.git.add(".");
      await this.git.commit(`Self‑improvement: ${this.improvementPrompt}`);
      console.info("Self‑improvement patch applied and committed.");
    } catch (err) {
      console.error("Self‑improvement cycle failed:", err);
      // In a full implementation we would invoke RecoveryPolicyEngine here.
    }
  }
}
