import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminPasskeyManager } from "../../src/security/adminPasskeys";

test("admin passkey registration requires platform user verification and produces a one-use ceremony", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-passkeys-"));
  try {
    const manager = new AdminPasskeyManager(path.join(tempDir, "security", "passkeys.json"));
    const ceremony = await manager.beginRegistration({ rpID: "localhost", origin: "http://localhost:3000", userName: "SARA admin" });
    assert.equal(ceremony.options.authenticatorSelection?.authenticatorAttachment, "platform");
    assert.equal(ceremony.options.authenticatorSelection?.userVerification, "required");
    assert.equal(manager.hasCredentials(), false);

    await assert.rejects(
      manager.finishRegistration({ ceremonyId: ceremony.ceremonyId, response: {} as any }),
    );
    await assert.rejects(
      manager.finishRegistration({ ceremonyId: ceremony.ceremonyId, response: {} as any }),
      /invalid, expired, or already used/i,
    );
    assert.equal(fs.existsSync(path.join(tempDir, "security", "passkeys.json")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin passkey sign-in fails closed when there is no enrolled credential", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-passkeys-"));
  try {
    const manager = new AdminPasskeyManager(path.join(tempDir, "passkeys.json"));
    await assert.rejects(manager.beginAuthentication({ rpID: "localhost", origin: "http://localhost:3000" }), /No admin passkey is enrolled/);
    assert.equal(manager.isValidSession("forged"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
