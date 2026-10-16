import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserIdentityManager } from "../../src/core/identity/UserIdentityManager";

function makeProfile(userId: string, displayName: string) {
  const timestamp = new Date().toISOString();
  return {
    userId,
    displayName,
    preferences: {},
    communicationStyle: {},
    permissions: [],
    memoryScope: userId,
    importantContext: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("legacy profiles are copied into the configured store without deleting the original", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-user-profile-store-"));
  const legacyPath = path.join(temporaryDirectory, "legacy", "user_profiles.json");
  const configuredPath = path.join(temporaryDirectory, "app-data", "user_profiles.json");
  const legacyProfile = makeProfile("alice", "Alice");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify([legacyProfile]), "utf8");

  try {
    const manager = new UserIdentityManager(configuredPath, legacyPath);
    assert.equal(manager.get("ALICE")?.displayName, "Alice");
    assert.equal(fs.existsSync(legacyPath), true, "migration must preserve the original profile file");
    assert.equal(fs.existsSync(configuredPath), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(configuredPath).mode & 0o077, 0, "profile data must not be readable by other local users");
    }

    fs.writeFileSync(legacyPath, JSON.stringify([makeProfile("bob", "Bob")]), "utf8");
    const reopened = new UserIdentityManager(configuredPath, legacyPath);
    assert.equal(reopened.get("alice")?.displayName, "Alice", "an existing configured store must not be overwritten by a later migration");
    assert.equal(reopened.get("bob"), null);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
