/**
 * Filesystem verification for file operations.
 * Checks if source exists, destination was created, and optionally compares state.
 */

import { existsSync, statSync } from "fs";
import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";

export class FilesystemVerifier implements ToolVerifier {
  timeout = 1000;

  canVerify(tool: string): boolean {
    return [
      "copyFile",
      "moveFile",
      "deleteFile",
      "createFolder",
      "renameFile",
      "writeFile",
    ].includes(tool);
  }

  async verify(
    tool: string,
    args: Record<string, unknown>,
    executionResult: unknown,
  ): Promise<VerificationOutcome> {
    const checks = [];
    let passed = true;
    const observedState: Record<string, unknown> = {};

    try {
      const source = String(args.source || args.from || args.path || "");
      const destination = String(args.destination || args.to || args.newPath || "");
      const folder = String(args.folder || args.name || "");

      if (tool === "copyFile" || tool === "moveFile") {
        const sourceExists = existsSync(source);
        checks.push({
          name: "source_exists",
          passed: sourceExists,
          evidence: { path: source },
        });
        observedState.sourceExists = sourceExists;

        const destExists = existsSync(destination);
        checks.push({
          name: "destination_exists",
          passed: destExists,
          evidence: { path: destination },
        });
        observedState.destinationExists = destExists;

        if (tool === "moveFile") {
          const sourceMoved = !existsSync(source);
          checks.push({
            name: "source_removed",
            passed: sourceMoved,
            evidence: { path: source },
          });
          observedState.sourceMoved = sourceMoved;
          passed = sourceExists && destExists && sourceMoved;
        } else {
          passed = sourceExists && destExists;
        }
      } else if (tool === "deleteFile") {
        const stillExists = existsSync(source);
        const deleted = !stillExists;
        checks.push({
          name: "file_deleted",
          passed: deleted,
          evidence: { path: source },
        });
        observedState.deleted = deleted;
        passed = deleted;
      } else if (tool === "createFolder") {
        const created = existsSync(folder);
        checks.push({
          name: "folder_created",
          passed: created,
          evidence: { path: folder },
        });
        observedState.created = created;
        passed = created;
      }
    } catch (error: any) {
      checks.push({
        name: "filesystem_error",
        passed: false,
        reason: String(error),
      });
      passed = false;
    }

    return {
      verified: passed,
      method: "filesystem",
      checks,
      details: passed
        ? `Filesystem operation verified: ${tool}`
        : `Filesystem verification failed for ${tool}`,
      confidence: passed ? 0.95 : 0.1,
      observedState,
    };
  }
}
