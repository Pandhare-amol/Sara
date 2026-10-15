/**
 * Independent postcondition checks for filesystem operations. The verifier
 * deliberately fails closed when it cannot prove that the requested state was
 * reached (for example, unsupported symlinks or very large directory trees).
 */

import { createHash } from "crypto";
import { createReadStream, existsSync } from "fs";
import { promises as fs } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";

const MAX_MANIFEST_ENTRIES = 5000;
const MAX_HASHED_BYTES = 1024 * 1024 * 1024;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function flattenPayload(value: unknown, depth = 0): Record<string, any> {
  const record = asRecord(value);
  if (depth > 4) return record;
  let flattened: Record<string, any> = {};
  for (const key of ["data", "result", "canonical", "unified"]) {
    if (record[key] && typeof record[key] === "object") {
      flattened = { ...flattened, ...flattenPayload(record[key], depth + 1) };
    }
  }
  return { ...flattened, ...record };
}

function resolveString(value: unknown): string {
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : "";
}

function pathExists(path: string): boolean {
  return Boolean(path) && existsSync(path);
}

async function hashFile(filePath: string): Promise<{ size: number; digest: string }> {
  const before = await fs.stat(filePath);
  if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (before.size > MAX_HASHED_BYTES) throw new Error(`File is too large to verify safely: ${filePath}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  const after = await fs.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`File changed while it was being verified: ${filePath}`);
  }
  return { size: after.size, digest: hash.digest("hex") };
}

async function treeManifest(root: string): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  let entriesSeen = 0;
  let bytesSeen = 0;

  const walk = async (absolutePath: string, relativePath: string): Promise<void> => {
    entriesSeen += 1;
    if (entriesSeen > MAX_MANIFEST_ENTRIES) throw new Error("Directory tree exceeds the safe verification entry limit.");
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported for copy verification: ${absolutePath}`);
    if (stat.isDirectory()) {
      manifest.set(relativePath || ".", "directory");
      const children = await fs.readdir(absolutePath, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        await walk(join(absolutePath, child.name), relativePath ? `${relativePath}/${child.name}` : child.name);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${absolutePath}`);
    bytesSeen += stat.size;
    if (bytesSeen > MAX_HASHED_BYTES) throw new Error("Directory tree exceeds the safe verification byte limit.");
    const file = await hashFile(absolutePath);
    manifest.set(relativePath || ".", `file:${file.size}:${file.digest}`);
  };

  await walk(root, "");
  return manifest;
}

function manifestsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, signature] of left) if (right.get(path) !== signature) return false;
  return true;
}

function verification(
  verified: boolean,
  checks: VerificationOutcome["checks"],
  details: string,
  observedState: Record<string, unknown>,
): VerificationOutcome {
  return {
    verified,
    method: "filesystem",
    checks,
    details,
    confidence: verified ? 0.98 : 0.1,
    observedState,
  };
}

export class FilesystemVerifier implements ToolVerifier {
  timeout = 5000;

  canVerify(tool: string): boolean {
    return [
      "copyFile",
      "duplicateFile",
      "moveFile",
      "deleteFile",
      "createFile",
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
    const checks: VerificationOutcome["checks"] = [];
    const observedState: Record<string, unknown> = {};
    const result = flattenPayload(executionResult);
    const toolReturnedOk = result.ok !== false;
    checks.push({ name: "tool_returned_ok", passed: toolReturnedOk });

    const source = resolveString(args.path || args.source || args.from);
    const resultPath = resolveString(result.path || result.target || result.newPath);
    const rawDestination = resultPath || resolveString(args.destination || args.target || args.to || args.newPath || args.new_path);

    try {
      if (tool === "copyFile" || tool === "duplicateFile") {
        if (!source || !rawDestination) throw new Error("Copy verification requires source and destination paths.");
        let destination = rawDestination;
        if (pathExists(destination) && (await fs.stat(destination)).isDirectory()) destination = join(destination, basename(source));
        const sourceExists = pathExists(source);
        const destinationExists = pathExists(destination);
        checks.push({ name: "source_exists", passed: sourceExists, evidence: { path: source } });
        checks.push({ name: "destination_exists", passed: destinationExists, evidence: { path: destination } });
        observedState.sourceExists = sourceExists;
        observedState.destinationExists = destinationExists;
        if (!sourceExists || !destinationExists) return verification(false, checks, "Copy source or destination is missing.", observedState);
        const [sourceManifest, destinationManifest] = await Promise.all([treeManifest(source), treeManifest(destination)]);
        const contentMatches = manifestsEqual(sourceManifest, destinationManifest);
        checks.push({ name: "copied_content_matches", passed: contentMatches, evidence: { sourceEntries: sourceManifest.size, destinationEntries: destinationManifest.size } });
        observedState.contentMatches = contentMatches;
        return verification(toolReturnedOk && contentMatches, checks, contentMatches ? "Copied content and filesystem structure verified." : "Destination content does not match the source.", observedState);
      }

      if (tool === "moveFile") {
        if (!source || !rawDestination) throw new Error("Move verification requires source and destination paths.");
        let destination = rawDestination;
        if (pathExists(destination) && (await fs.stat(destination)).isDirectory()) destination = join(destination, basename(source));
        const sourceRemoved = !pathExists(source);
        const destinationExists = pathExists(destination);
        checks.push({ name: "source_removed", passed: sourceRemoved, evidence: { path: source } });
        checks.push({ name: "destination_exists", passed: destinationExists, evidence: { path: destination } });
        observedState.sourceRemoved = sourceRemoved;
        observedState.destinationExists = destinationExists;
        const passed = toolReturnedOk && sourceRemoved && destinationExists;
        return verification(passed, checks, passed ? "Move postconditions verified." : "Move postconditions were not both observed.", observedState);
      }

      if (tool === "deleteFile") {
        if (!source) throw new Error("Delete verification requires a path.");
        const deleted = !pathExists(source);
        checks.push({ name: "source_absent", passed: deleted, evidence: { path: source } });
        observedState.deleted = deleted;
        return verification(toolReturnedOk && deleted, checks, deleted ? "Deleted path is absent." : "The requested path still exists.", observedState);
      }

      if (tool === "renameFile") {
        if (!source) throw new Error("Rename verification requires the original path.");
        const newName = typeof args.new_name === "string" ? args.new_name : "";
        const destination = rawDestination || (newName ? resolve(join(dirname(source), newName)) : "");
        if (!destination) throw new Error("Rename verification requires the new path or name.");
        const sourceRemoved = source !== destination && !pathExists(source);
        const destinationExists = pathExists(destination);
        checks.push({ name: "original_path_removed", passed: sourceRemoved, evidence: { path: source } });
        checks.push({ name: "renamed_path_exists", passed: destinationExists, evidence: { path: destination } });
        observedState.sourceRemoved = sourceRemoved;
        observedState.destinationExists = destinationExists;
        const passed = toolReturnedOk && sourceRemoved && destinationExists;
        return verification(passed, checks, passed ? "Rename postconditions verified." : "Rename postconditions were not both observed.", observedState);
      }

      if (tool === "createFile" || tool === "writeFile") {
        const destination = resultPath || source;
        if (!destination) throw new Error("File verification requires a path.");
        const exists = pathExists(destination) && (await fs.stat(destination)).isFile();
        checks.push({ name: "file_exists", passed: exists, evidence: { path: destination } });
        observedState.exists = exists;
        if (!exists) return verification(false, checks, "Expected file was not found.", observedState);
        const expectedContent = typeof args.content === "string" ? args.content : tool === "createFile" ? "" : undefined;
        if (expectedContent !== undefined) {
          const actualContent = await fs.readFile(destination, "utf8");
          const contentMatches = actualContent === expectedContent;
          checks.push({ name: "file_content_matches", passed: contentMatches, evidence: { expectedCharacters: expectedContent.length, actualCharacters: actualContent.length } });
          observedState.contentMatches = contentMatches;
          return verification(toolReturnedOk && contentMatches, checks, contentMatches ? "File content verified." : "File content differs from the requested content.", observedState);
        }
        checks.push({ name: "file_content_supplied_for_verification", passed: false, reason: "The expected content was not available for comparison." });
        return verification(false, checks, "File exists, but its expected content was not available for verification.", observedState);
      }

      if (tool === "createFolder") {
        const destination = resultPath || resolveString(args.path || args.name || args.folder);
        if (!destination) throw new Error("Folder verification requires a path.");
        const exists = pathExists(destination) && (await fs.stat(destination)).isDirectory();
        checks.push({ name: "folder_exists", passed: exists, evidence: { path: destination } });
        observedState.exists = exists;
        return verification(toolReturnedOk && exists, checks, exists ? "Folder exists at the requested path." : "Expected folder was not found.", observedState);
      }

      return verification(false, checks, `No filesystem verifier is implemented for ${tool}.`, observedState);
    } catch (error) {
      checks.push({ name: "filesystem_verification_error", passed: false, reason: error instanceof Error ? error.message : String(error) });
      return verification(false, checks, `Filesystem verification failed for ${tool}.`, observedState);
    }
  }
}
