import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FilesystemVerifier } from "../src/core/tools/verification/filesystemVerifier";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sara-fs-verify-"));
  try { return await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

const verifier = new FilesystemVerifier();

test("copy verification checks destination content, not only path existence", async () => {
  await withTempDir(async (directory) => {
    const source = path.join(directory, "source.txt");
    const destination = path.join(directory, "copy.txt");
    await fs.writeFile(source, "same bytes");
    await fs.writeFile(destination, "same bytes");
    const matched = await verifier.verify("copyFile", { path: source, destination }, { ok: true, path: destination });
    assert.equal(matched.verified, true);

    await fs.writeFile(destination, "different bytes");
    const mismatched = await verifier.verify("copyFile", { path: source, destination }, { ok: true, path: destination });
    assert.equal(mismatched.verified, false);
    assert.equal(mismatched.checks.find((check) => check.name === "copied_content_matches")?.passed, false);
  });
});

test("move verification requires the source to be absent and the actual destination to exist", async () => {
  await withTempDir(async (directory) => {
    const source = path.join(directory, "source.txt");
    const destinationFolder = path.join(directory, "destination");
    const destination = path.join(destinationFolder, "source.txt");
    await fs.mkdir(destinationFolder);
    await fs.writeFile(destination, "moved");
    const verified = await verifier.verify("moveFile", { path: source, destination: destinationFolder }, { ok: true, path: destination });
    assert.equal(verified.verified, true);
  });
});

test("rename and delete verification check their postconditions", async () => {
  await withTempDir(async (directory) => {
    const original = path.join(directory, "old.txt");
    const renamed = path.join(directory, "new.txt");
    await fs.writeFile(renamed, "data");
    const rename = await verifier.verify("renameFile", { path: original, new_name: "new.txt" }, { ok: true, path: renamed });
    assert.equal(rename.verified, true);

    const deleted = await verifier.verify("deleteFile", { path: original }, { ok: true });
    assert.equal(deleted.verified, true);
    const failedDelete = await verifier.verify("deleteFile", { path: renamed }, { ok: true });
    assert.equal(failedDelete.verified, false);
  });
});

test("create and write verification compares requested text", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "created.txt");
    await fs.writeFile(file, "expected");
    const result = await verifier.verify("createFile", { path: file, content: "expected" }, { ok: true, path: file });
    assert.equal(result.verified, true);
    const wrong = await verifier.verify("writeFile", { path: file, content: "different" }, { ok: true, path: file });
    assert.equal(wrong.verified, false);
  });
});

test("filesystem verification fails closed when the tool explicitly reports failure", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "already-there.txt");
    await fs.writeFile(file, "data");
    const result = await verifier.verify("createFile", { path: file, content: "data" }, { ok: false, path: file });
    assert.equal(result.verified, false);
  });
});
