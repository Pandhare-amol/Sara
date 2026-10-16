import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { MultiUserStore } from "../../src/security/multiUserStore";
import { createMultiUserRouter } from "../../src/security/multiUserHttp";

/** Protocol-only software fixture. It proves server challenge, signature, RP,
 * origin and UV-flag checks, NOT that a platform device verified a real person.
 * No actual browser, hardware authenticator or biometric data is used here. */
const context = { rpID: "localhost", origin: "http://localhost:3000" };
const b64 = (data: Buffer | Uint8Array) => Buffer.from(data).toString("base64url");
const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest();

function registration(challenge: string, key: crypto.KeyObject, credentialId: Buffer,
  origin = context.origin, flags = 0x45): RegistrationResponseJSON {
  const jwk = crypto.createPublicKey(key).export({ format: "jwk" });
  assert.ok(jwk.x && jwk.y);
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")],
  ]));
  const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
  const counter = Buffer.alloc(4);
  const authData = Buffer.concat([sha(context.rpID), Buffer.from([flags]), counter, Buffer.alloc(16), length, credentialId, Buffer.from(cose)]);
  const attestationObject = isoCBOR.encode(new Map<string, string | Uint8Array | Map<unknown, unknown>>([
    ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
  ]));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  return { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: {
    attestationObject: b64(attestationObject), clientDataJSON: b64(clientDataJSON), transports: ["internal"],
  }, clientExtensionResults: {}, authenticatorAttachment: "platform" } as RegistrationResponseJSON;
}
function assertion(challenge: string, key: crypto.KeyObject, credentialId: Buffer,
  count: number, origin = context.origin, flags = 0x05): AuthenticationResponseJSON {
  const counter = Buffer.alloc(4); counter.writeUInt32BE(count);
  const authData = Buffer.concat([sha(context.rpID), Buffer.from([flags]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
  const signature = crypto.sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), key);
  return { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: {
    authenticatorData: b64(authData), clientDataJSON: b64(clientDataJSON), signature: b64(signature), userHandle: undefined,
  }, clientExtensionResults: {}, authenticatorAttachment: "platform" } as AuthenticationResponseJSON;
}

test("software-signed WebAuthn verifies consent, account binding, RP/origin/UV/signature/counter and revocation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-protocol-passkey-"));
  try {
    const store = new MultiUserStore(dir);
    store.bootstrap("Owner");
    const aliceInvite = store.createAccount("Alice", "member");
    const bobInvite = store.createAccount("Bob", "member");
    const alice = store.acceptInvitation(aliceInvite.account.id, aliceInvite.invitation);
    const bob = store.acceptInvitation(bobInvite.account.id, bobInvite.invitation);
    const recovery = store.issueOwnRecoveryCode(alice.session);
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const credentialId = crypto.randomBytes(32);

    await assert.rejects(store.beginEnrollment(alice.session, context, false), /consent/);
    const bound = await store.beginEnrollment(alice.session, context, true);
    await assert.rejects(store.finishEnrollment(bob.session, bound.ceremonyId,
      registration(bound.options.challenge, privateKey, credentialId)), /belongs to another session/);
    const noUv = await store.beginEnrollment(alice.session, context, true);
    await assert.rejects(store.finishEnrollment(alice.session, noUv.ceremonyId,
      registration(noUv.options.challenge, privateKey, credentialId, context.origin, 0x41)), /verification/);
    const badOrigin = await store.beginEnrollment(alice.session, context, true);
    await assert.rejects(store.finishEnrollment(alice.session, badOrigin.ceremonyId,
      registration(badOrigin.options.challenge, privateKey, credentialId, "http://attacker.example")), /origin/);
    assert.equal(store.ownProfile(aliceInvite.account.id)?.hasPasskey, false);

    const start = await store.beginEnrollment(alice.session, context, true);
    const registered = await store.finishEnrollment(alice.session, start.ceremonyId,
      registration(start.options.challenge, privateKey, credentialId));
    assert.equal(registered.id, aliceInvite.account.id);
    assert.equal(registered.hasPasskey, true);
    assert.equal(store.ownPasskeys(aliceInvite.account.id)[0].id, b64(credentialId));
    await assert.rejects(store.beginPasskeyLogin(bobInvite.account.id, context), /No passkey/);
    await assert.rejects(store.finishEnrollment(alice.session, start.ceremonyId,
      registration(start.options.challenge, privateKey, credentialId)), /already used/);

    const forged = await store.beginPasskeyLogin(aliceInvite.account.id, context);
    const otherKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    await assert.rejects(store.finishPasskeyLogin(forged.ceremonyId,
      assertion(forged.options.challenge, otherKey, credentialId, 1)), /verification/);
    const absentUv = await store.beginPasskeyLogin(aliceInvite.account.id, context);
    await assert.rejects(store.finishPasskeyLogin(absentUv.ceremonyId,
      assertion(absentUv.options.challenge, privateKey, credentialId, 1, context.origin, 0x01)), /verification/);
    const wrongOrigin = await store.beginPasskeyLogin(aliceInvite.account.id, context);
    await assert.rejects(store.finishPasskeyLogin(wrongOrigin.ceremonyId,
      assertion(wrongOrigin.options.challenge, privateKey, credentialId, 1, "http://attacker.example")), /origin/);

    const login = await store.beginPasskeyLogin(aliceInvite.account.id, context);
    const signedIn = await store.finishPasskeyLogin(login.ceremonyId,
      assertion(login.options.challenge, privateKey, credentialId, 1));
    assert.equal(signedIn.session.userId, aliceInvite.account.id);
    assert.equal(signedIn.session.method, "passkey");
    assert.throws(() => store.requireSession("not-a-token"));
    await assert.rejects(store.finishPasskeyLogin(login.ceremonyId,
      assertion(login.options.challenge, privateKey, credentialId, 2)), /already used/);
    const staleCount = await store.beginPasskeyLogin(aliceInvite.account.id, context);
    await assert.rejects(store.finishPasskeyLogin(staleCount.ceremonyId,
      assertion(staleCount.options.challenge, privateKey, credentialId, 1)), /counter/);

    store.revokeOwnPasskey(signedIn.session, b64(credentialId));
    assert.throws(() => store.requireSession(signedIn.token));
    await assert.rejects(store.beginPasskeyLogin(aliceInvite.account.id, context), /No passkey/);
    assert.equal(store.recover(aliceInvite.account.id, recovery).session.userId, aliceInvite.account.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an expired enrollment session cannot register a verified software credential after the cryptographic check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-expired-passkey-"));
  try {
    const store = new MultiUserStore(dir);
    store.bootstrap("Owner");
    const invite = store.createAccount("Member", "member");
    const member = store.acceptInvitation(invite.account.id, invite.invitation);
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const started = await store.beginEnrollment(member.session, context, true);
    const file = path.join(dir, "security", "multiuser.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.sessions.find((s: { userId: string }) => s.userId === member.session.userId).freshUntil = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(state));
    await assert.rejects(store.finishEnrollment(member.session, started.ceremonyId,
      registration(started.options.challenge, privateKey, crypto.randomBytes(32))), /revoked or expired/);
    assert.equal(store.ownProfile(invite.account.id)?.hasPasskey, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("admin security endpoints need BOTH an explicit owner grant and a fresh verified credential", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-admin-grant-"));
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const store = new MultiUserStore(dir);
    const owner = store.bootstrap("Owner");
    const invite = store.createAccount("Admin", "admin");
    const admin = store.acceptInvitation(invite.account.id, invite.invitation);
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const credentialId = crypto.randomBytes(32);
    const started = await store.beginEnrollment(admin.session, context, true);
    await store.finishEnrollment(admin.session, started.ceremonyId,
      registration(started.options.challenge, privateKey, credentialId));

    const app = express(); app.use(express.json());
    app.use("/api/users", createMultiUserRouter(store, () => "local-admin-secret-32-chars-for-test"));
    server = await new Promise((resolve) => {
      const node = app.listen(0, "127.0.0.1", () => resolve(node));
    });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const call = async (route: string, method: string, token: string, data?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/users${route}`, {
        method, headers: { "x-sara-session": token, "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: res.status, body: await res.json() as any };
    };
    assert.equal((await call("/security/activity", "GET", admin.token)).status, 403,
      "admin title and an invitation session confer no security-event view");
    assert.equal((await call("/settings", "PATCH", admin.token, { sessionIdleMinutes: 10 })).status, 403);
    store.updateAccount(invite.account.id,
      { allow: ["manage_security_settings", "view_security_events"] }, owner.account.id);
    assert.equal((await call("/security/activity", "GET", admin.token)).status, 403,
      "the grant revokes old sessions and needs new platform-style verification");

    const login = await store.beginPasskeyLogin(invite.account.id, context);
    const verified = await store.finishPasskeyLogin(login.ceremonyId,
      assertion(login.options.challenge, privateKey, credentialId, 1));
    assert.equal(verified.session.method, "passkey");
    assert.equal((await call("/security/activity", "GET", verified.token)).status, 200);
    const changed = await call("/settings", "PATCH", verified.token, { sessionIdleMinutes: 5 });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.settings.sessionIdleMinutes, 5);
    store.updateAccount(invite.account.id, { role: "member" }, owner.account.id);
    assert.equal((await call("/settings", "PATCH", verified.token, { sessionIdleMinutes: 10 })).status, 403);
    assert.equal(store.systemSettings().sessionIdleMinutes, 5);
    assert.equal((await call("/security/activity", "GET", owner.token)).status, 200,
      "an existing original owner keeps their security event access");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
