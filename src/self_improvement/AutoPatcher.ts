// src/self_improvement/AutoPatcher.ts
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import * as path from "path";
import { EventBus } from "../core/events/EventBus";

/**
 * Applies a code patch safely.
 * In a real system this would run the diff through linting, type‑checking,
 * and a sandboxed Python helper. Here we implement a minimal synchronous
 * approach for demonstration purposes.
 */
export class AutoPatcher {
  constructor() {}

  /**
   * Validate and apply a diff to a file.
   * @param file absolute path to the target file
   * @param diff unified diff string
   * @returns true if applied successfully, false otherwise
   */
  applyPatch(file: string, diff: string): boolean {
    try {
      if (!existsSync(file)) {
        console.warn(`AutoPatcher: target file does not exist ${file}`);
        return false;
      }
      // Write diff to a temporary .patch file
      const patchPath = file + ".patch";
      writeFileSync(patchPath, diff, "utf8");

      // Use `git apply` for validation (requires git in PATH)
      execSync(`git apply --check "${patchPath}"`, { stdio: "ignore" });

      // Apply the patch
      execSync(`git apply "${patchPath}"`, { stdio: "ignore" });

      // Clean up
      execSync(`rm "${patchPath}"`);

      EventBus.instance.emitEvent("patchApplied", { file, status: "success" });
      return true;
    } catch (e) {
      console.error(`AutoPatcher: failed to apply patch to ${file}`, e);
      EventBus.instance.emitEvent("patchApplied", { file, status: "failure", error: e });
      return false;
    }
  }
}
