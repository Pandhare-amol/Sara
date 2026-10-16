import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MultiUserStore } from "../../src/security/multiUserStore";
import { belongsToUserConversation, readUserMemories, writeUserMemories, userDataPath } from "../../src/security/userData";
import { createApprovedMemory } from "../../src/core/memory/approvedMemory";

function sandbox(fn: (store: MultiUserStore, dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-users-"));
    try { await fn(new MultiUserStore(dir), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
const ownerSecret = "an-example-owner-secret-with-32-plus-characters-for-tests";

test("opt-in migration backs up legacy records and claims them only for the stable original owner", sandbox((store, dir) => {
  assert.equal(store.isEnabled(), false);
  fs.writeFileSync(path.join(dir, "conversations.json"), '[{"id":"legacy-chat"}]');
  fs.writeFileSync(path.join(dir, "memories.json"), '[{"id":"old-memory"}]');
  fs.writeFileSync(path.join(dir, "user_profiles.json"), '[{"userId":"other-claimed"}]');
  const first = store.bootstrap("Original Owner");
  assert.equal(first.account.id, "default-user");
  assert.equal(store.isEnabled(), true);
  assert.deepEqual(store.list().map((a) => a.id), ["default-user"], "unverified old profiles are not enrolled");
  assert.equal(store.requireSession(first.token).userId, "default-user");
  const folder = fs.readdirSync(path.join(dir, "security")).find((item) => item.startsWith("backup-"));
  assert.ok(folder);
  assert.equal(fs.readFileSync(path.join(dir, "security", folder!, "conversations.json"), "utf8"), '[{"id":"legacy-chat"}]');
  assert.equal(fs.readFileSync(path.join(dir, "conversations.json"), "utf8"), '[{"id":"legacy-chat"}]');
  assert.throws(() => store.bootstrap("Someone else"));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "security", "multiuser.json")).mode & 0o777, 0o600);
}));

test("stable IDs, separate relationships, and roles do not grant access to someone else's content", sandbox((store) => {
  store.bootstrap("Owner");
  const a = store.createAccount("Teacher", "member");
  const b = store.createAccount("Learner", "restricted");
  const admin = store.createAccount("Coordinator", "admin");
  assert.deepEqual(store.roles().admin, ["chat", "memory"], "administration requires an explicit manage_users grant");
  assert.equal(admin.account.capabilities.includes("manage_users"), false);
  assert.ok(store.updateAccount(admin.account.id, { allow: ["manage_users"] }).capabilities.includes("manage_users"));
  assert.deepEqual(store.updateAccount(admin.account.id, { role: "restricted" }).capabilities, [],
    "a role change clears old exceptional grants rather than carrying privileges to a lower-trust role");
  assert.deepEqual(b.account.capabilities, [], "restricted accounts have no default private-data grants");
  assert.deepEqual(store.updateAccount(b.account.id, { allow: ["chat"] }).capabilities, ["chat"]);
  assert.notEqual(a.account.id, b.account.id);
  const label = store.addRelationship(a.account.id, b.account.id, "teacher");
  assert.equal(label.label, "teacher");
  assert.equal(store.ownProfile(a.account.id)?.id, a.account.id);
  assert.deepEqual(store.readRelationships(a.account.id).map((r) => r.id), [label.id]);
  assert.equal(store.ownProfile(a.account.id)?.capabilities.includes("manage_users"), false);
  assert.throws(() => store.updateAccount(a.account.id, { allow: ["read_others_memory" as any] }));
  assert.deepEqual(store.ownProfile(a.account.id)?.capabilities, ["chat", "memory"]);
}));

test("one-time invitation cannot be replayed or used to impersonate another user", sandbox((store) => {
  store.bootstrap("Owner");
  const alice = store.createAccount("Alice", "member");
  const bob = store.createAccount("Bob", "member");
  assert.throws(() => store.acceptInvitation(bob.account.id, alice.invitation));
  const signedIn = store.acceptInvitation(alice.account.id, alice.invitation);
  assert.equal(signedIn.session.userId, alice.account.id);
  assert.equal(signedIn.session.method, "invitation");
  assert.throws(() => store.acceptInvitation(alice.account.id, alice.invitation));
  assert.throws(() => store.requireFresh(signedIn.session), "invitation isn't strong manager reauthentication");
}));

test("session hashes are persisted, idle/absolute expiry and logout/revocation are enforced", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  const file = path.join(dir, "security", "multiuser.json");
  assert.equal(fs.readFileSync(file, "utf8").includes(owner.token), false);
  assert.equal(new MultiUserStore(dir).requireSession(owner.token).userId, "default-user", "session survives a restart");
  store.revoke(owner.token);
  assert.throws(() => store.requireSession(owner.token));
  const second = store.authenticateOwner(ownerSecret, ownerSecret);
  assert.equal(second.session.role, "owner");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.sessions[0].lastSeenAt = 0;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => store.requireSession(second.token), "idle session expired");
}));

test("configurable inactivity locking ignores status checks but counts an authenticated action", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  assert.equal(store.systemSettings().sessionIdleMinutes, 15);
  assert.throws(() => store.updateSystemSettings(0), /Idle lock/);
  assert.throws(() => store.updateSystemSettings(61), /Idle lock/);
  assert.equal(store.updateSystemSettings(5).sessionIdleMinutes, 5);
  const file = path.join(dir, "security", "multiuser.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const seen = Date.now() - 4 * 60_000;
  state.sessions[0].lastSeenAt = seen;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(store.requireSession(owner.token, { activity: false }).userId, "default-user");
  assert.equal(store.requireSession(owner.token, { activity: false }).userId, "default-user");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0].lastSeenAt, seen,
    "status polling must not keep an idle account signed in");
  store.requireSession(owner.token);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0].lastSeenAt > seen,
    "an authenticated action refreshes the inactivity window");
  const expired = JSON.parse(fs.readFileSync(file, "utf8"));
  expired.sessions[0].lastSeenAt = Date.now() - 5 * 60_000 - 2000;
  fs.writeFileSync(file, JSON.stringify(expired));
  assert.throws(() => store.requireSession(owner.token, { activity: false }), /expired/);
  assert.throws(() => store.requireSession(owner.token), /expired/);
  assert.equal(new MultiUserStore(dir).systemSettings().sessionIdleMinutes, 5, "configuration survives restart");
}));

test("a member can set their own salted fallback passphrase; another account and recovery cannot reuse it", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  const first = store.createAccount("Alice", "member");
  const second = store.createAccount("Bob", "member");
  const alice = store.acceptInvitation(first.account.id, first.invitation);
  assert.throws(() => store.authenticatePassphrase(first.account.id, "not-initialized"));
  assert.throws(() => store.setOwnPassphrase(alice.session, "weak"));
  store.setOwnPassphrase(alice.session, "my unique account passphrase 2026");
  assert.equal(fs.readFileSync(path.join(dir, "security", "multiuser.json"), "utf8").includes("my unique account passphrase 2026"), false);
  const auth = store.authenticatePassphrase(first.account.id, "my unique account passphrase 2026");
  assert.equal(auth.session.userId, first.account.id);
  assert.equal(auth.session.method, "passphrase");
  assert.throws(() => store.authenticatePassphrase(second.account.id, "my unique account passphrase 2026"));
  assert.throws(() => store.setOwnPassphrase({ ...store.requireSession(owner.token), userId: first.account.id }, "a different user password 2026"));
  const selfRecovery = store.issueOwnRecoveryCode(auth.session);
  store.recover(first.account.id, selfRecovery);
  assert.throws(() => store.authenticatePassphrase(first.account.id, "my unique account passphrase 2026"));
}));

test("self-revoking an enrolled passkey removes it and all current sessions", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  const file = path.join(dir, "security", "multiuser.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  // A synthetic credential tests revocation only. It cannot sign a WebAuthn
  // challenge; an actual-device authenticator is deliberately not simulated.
  state.accounts[0].credentials.push({ id: "synthetic-credential", publicKey: "not-a-key", counter: 0,
    transports: [], createdAt: new Date().toISOString(), consentedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(store.ownPasskeys(owner.account.id).length, 1);
  assert.throws(() => store.revokeOwnPasskey(store.requireSession(owner.token), "other-id"), /not enrolled/);
  store.revokeOwnPasskey(store.requireSession(owner.token), "synthetic-credential");
  assert.deepEqual(store.ownPasskeys(owner.account.id), []);
  assert.throws(() => store.requireSession(owner.token), /revoked/);
  assert.equal(store.authenticateOwner(ownerSecret, ownerSecret).session.userId, owner.account.id,
    "owner can still sign in with the local owner secret");
}));

test("guest permission cannot persist memories even when a role policy tries to grant them", sandbox((store) => {
  store.bootstrap("Owner");
  const guest = store.createAccount("Visitor", "guest");
  store.updateRole("guest", ["chat", "memory", "manage_users", "manage_security_settings", "view_security_events"]);
  const signedIn = store.acceptInvitation(guest.account.id, guest.invitation);
  assert.deepEqual(signedIn.session.capabilities, ["chat"]);
  assert.ok(signedIn.session.expiresAt - Date.now() <= 30 * 60_000);
}));

test("role changes and account disable revoke live sessions; original owner cannot be demoted", sandbox((store) => {
  store.bootstrap("Owner");
  const invite = store.createAccount("Member", "member");
  const first = store.acceptInvitation(invite.account.id, invite.invitation);
  const selfRecovery = store.issueOwnRecoveryCode(first.session);
  store.updateRole("member", ["chat"]);
  assert.throws(() => store.requireSession(first.token));
  assert.throws(() => store.rotateInvitation(invite.account.id), "accepted invitation is not a bypass for privacy");
  const second = store.recover(invite.account.id, selfRecovery);
  store.updateAccount(invite.account.id, { disabled: true });
  assert.throws(() => store.requireSession(second.token));
  assert.throws(() => store.updateAccount("default-user", { role: "guest" }));
  assert.throws(() => store.updateRole("owner", []));
}));

test("account recovery consumes a single code, revokes previous sessions and requires renewed credential enrollment", sandbox((store) => {
  const owner = store.bootstrap("Owner");
  const account = store.createAccount("Recovering User", "member");
  const active = store.acceptInvitation(account.account.id, account.invitation);
  assert.throws(() => store.rotateInvitation(account.account.id), "owner cannot issue a new code for a person with history");
  const recovery = store.issueOwnRecoveryCode(active.session);
  assert.throws(() => store.issueOwnRecoveryCode({ ...store.requireSession(owner.token), userId: account.account.id }),
    "changing a claimed userId never authorizes a recovery code for another person");
  const recovered = store.recover(account.account.id, recovery);
  assert.equal(recovered.session.method, "recovery");
  assert.throws(() => store.requireSession(active.token));
  assert.throws(() => store.recover(account.account.id, recovery));
  assert.equal(store.ownProfile(account.account.id)?.hasPasskey, false);
  assert.equal(store.requireSession(owner.token).role, "owner");
}));

test("consent and platform verification are mandatory; a forged passkey response cannot authenticate", sandbox(async (store) => {
  store.bootstrap("Owner");
  const account = store.createAccount("Consent test", "member");
  const signedIn = store.acceptInvitation(account.account.id, account.invitation);
  const context = { rpID: "localhost", origin: "http://localhost:3000" };
  await assert.rejects(store.beginEnrollment(signedIn.session, context, false), /consent/);
  const challenge = await store.beginEnrollment(signedIn.session, context, true);
  await assert.rejects(store.finishEnrollment(signedIn.session, challenge.ceremonyId, { id: "forged" } as any));
  await assert.rejects(store.finishEnrollment(signedIn.session, challenge.ceremonyId, { id: "forged" } as any), /already used/);
  assert.equal(store.ownProfile(account.account.id)?.hasPasskey, false);
}));

test("private user stores and prefixed conversation IDs cannot address owner or another account", sandbox((store, dir) => {
  store.bootstrap("Owner");
  const alice = store.createAccount("Alice", "member");
  const bob = store.createAccount("Bob", "member");
  const memory = createApprovedMemory({ category: "preference", text: "Alice secret context" });
  writeUserMemories(dir, alice.account.id, [memory]);
  assert.deepEqual(readUserMemories(dir, bob.account.id), []);
  assert.equal(readUserMemories(dir, alice.account.id)[0].text, "Alice secret context");
  const id = `${alice.account.id}:desktop-1234`;
  assert.equal(belongsToUserConversation(alice.account.id, id), true);
  assert.equal(belongsToUserConversation(bob.account.id, id), false);
  assert.equal(belongsToUserConversation("default-user", id), false);
  assert.throws(() => userDataPath(dir, "../../etc", "memories.json"));
}));

test("invalid or missing mandatory account state locks protected mode rather than falling back to legacy", sandbox((store, dir) => {
  const required = new MultiUserStore(dir, true);
  assert.equal(required.isEnabled(), true);
  assert.equal(required.isInitialized(), false, "required mode remains locked until owner bootstrap");
  const pending = path.join(dir, "security", "multiuser.pending");
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, "pending");
  assert.equal(store.isEnabled(), true, "interrupted activation cannot fall back to legacy access");
  assert.equal(store.isInitialized(), false);
  store.bootstrap("Owner");
  assert.equal(fs.existsSync(pending), false);
  const file = path.join(dir, "security", "multiuser.json");
  fs.writeFileSync(file, "{broken");
  assert.equal(store.isEnabled(), true);
  assert.throws(() => store.list());
  assert.throws(() => store.authenticateOwner(ownerSecret, ownerSecret));
}));
