import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserIdentityManager } from "../src/core/identity/UserIdentityManager.ts";

test("user identity manager persists explicit profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-users-"));
  const store = path.join(directory, "profiles.json");
  const manager = new UserIdentityManager(store);
  const profile = manager.upsert({
    userId: " Amol Patil ", displayName: "Amol", relationship: "owner",
    permissions: ["chat", "chat"], preferences: { language: "en" },
  });

  assert.equal(profile.userId, "amol-patil");
  assert.deepEqual(profile.permissions, ["chat"]);
  assert.equal(manager.get("amol-patil")?.displayName, "Amol");
  assert.equal(JSON.parse(fs.readFileSync(store, "utf8")).length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("user identity manager updates and removes profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-users-"));
  const manager = new UserIdentityManager(path.join(directory, "profiles.json"));
  manager.upsert({ userId: "guest", displayName: "Guest" });
  manager.upsert({ userId: "guest", displayName: "Guest User", memoryScope: "guest" });
  assert.equal(manager.list()[0].displayName, "Guest User");
  assert.equal(manager.remove("guest"), true);
  assert.equal(manager.list().length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});
