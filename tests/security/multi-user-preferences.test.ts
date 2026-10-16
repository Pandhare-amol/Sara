import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MultiUserStore } from "../../src/security/multiUserStore";

function sandbox(fn: (store: MultiUserStore, dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-profile-test-"));
    try { await fn(new MultiUserStore(dir), dir); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test("only the signed-in account controls its validated preferences; the directory never contains them", sandbox((store, dir) => {
  const owner = store.bootstrap("Original owner");
  const aliceInvite = store.createAccount("Alice", "member");
  const bobInvite = store.createAccount("Bob", "member");
  const guestInvite = store.createAccount("Guest", "guest");
  const alice = store.acceptInvitation(aliceInvite.account.id, aliceInvite.invitation);
  const bob = store.acceptInvitation(bobInvite.account.id, bobInvite.invitation);
  const guest = store.acceptInvitation(guestInvite.account.id, guestInvite.invitation);
  assert.deepEqual(store.ownProfile(aliceInvite.account.id)?.preferences,
    { language: "en", personalizedGreeting: false, proactiveConversation: false }, "old version-1 records default safely");
  const updated = store.updatePreferences(alice.session, { language: "mr", personalizedGreeting: true });
  assert.deepEqual(updated.preferences, { language: "mr", personalizedGreeting: true, proactiveConversation: false });
  assert.deepEqual(new MultiUserStore(dir).ownProfile(aliceInvite.account.id)?.preferences, updated.preferences);
  assert.equal("preferences" in store.list().find((person) => person.id === aliceInvite.account.id)!, false,
    "a manager must not receive another person's language/consent settings");
  assert.equal(store.ownProfile(bobInvite.account.id)?.preferences.language, "en");
  assert.equal(store.ownProfile(owner.account.id)?.preferences.personalizedGreeting, false);
  assert.throws(() => store.updatePreferences({ ...bob.session, userId: aliceInvite.account.id }, { language: "hi" }), /revoked/);
  assert.throws(() => store.updatePreferences(guest.session, { language: "hi" }), /Guest preferences/);
  for (const invalid of [{ language: "__proto__" }, { voiceIdentity: "Alice" }, { personalizedGreeting: "yes" },
    { proactiveConversation: 1 }, JSON.parse('{"__proto__":{"admin":true}}'),
    JSON.parse('{"toString":"override"}'), {}, null]) {
    assert.throws(() => store.updatePreferences(alice.session, invalid));
  }
  assert.equal(store.ownProfile(aliceInvite.account.id)?.preferences.language, "mr", "bad input must not overwrite a choice");
  const file = path.join(dir, "security", "multiuser.json");
  const broken = JSON.parse(fs.readFileSync(file, "utf8"));
  broken.accounts.find((person: { id: string }) => person.id === aliceInvite.account.id).preferences.language = "invalid";
  fs.writeFileSync(file, JSON.stringify(broken));
  assert.throws(() => store.list(), /invalid/, "corrupt persisted preferences must fail closed");
}));

test("only a fresh, strongly verified owner revokes another account's sessions, not their content", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  const invite = store.createAccount("Member", "member");
  const member = store.acceptInvitation(invite.account.id, invite.invitation);
  assert.equal(store.list().find((item) => item.id === invite.account.id)?.activeSessions, 1);
  assert.ok(store.list().find((item) => item.id === invite.account.id)?.lastUsedAt);
  assert.throws(() => store.revokeAccountSessions(member.session, owner.account.id));
  assert.throws(() => store.revokeAccountSessions({ ...member.session, role: "owner" }, invite.account.id),
    "a forged role must not revoke someone else's sessions");
  assert.throws(() => store.revokeAccountSessions(store.requireSession(owner.token), owner.account.id));
  assert.equal(store.revokeAccountSessions(store.requireSession(owner.token), invite.account.id), 1);
  assert.equal(store.list().find((item) => item.id === invite.account.id)?.activeSessions, 0);
  assert.throws(() => store.requireSession(member.token), /revoked/);
  assert.equal(store.ownProfile(invite.account.id)?.id, invite.account.id);
  assert.ok(store.readOwnAudit(invite.account.id).some((event) => event.action === "account_sessions_revoked" && event.actor === owner.account.id));

  const next = store.createAccount("Another", "member");
  store.acceptInvitation(next.account.id, next.invitation);
  const file = path.join(dir, "security", "multiuser.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.sessions.find((item: { userId: string }) => item.userId === owner.account.id).freshUntil = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => store.revokeAccountSessions(store.requireSession(owner.token), next.account.id), /Fresh owner/);
  assert.equal(store.list().find((item) => item.id === next.account.id)?.activeSessions, 1,
    "an expired re-verification window cannot revoke a valid account");
}));

test("existing version-1 owner stores gain safe security controls without rewriting private data", sandbox((store, dir) => {
  const owner = store.bootstrap("Owner");
  const file = path.join(dir, "security", "multiuser.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.roles.owner = ["chat", "memory", "manage_users"];
  fs.writeFileSync(file, JSON.stringify(state));
  assert.ok(store.roles().owner.includes("view_security_events"));
  assert.ok(store.requireSession(owner.token).capabilities.includes("manage_security_settings"));
  assert.equal(store.ownProfile(owner.account.id)?.preferences.language, "en");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roles.owner,
    ["chat", "memory", "manage_users"], "reads must not silently mutate or discard a version-1 account store");
}));

test("temporary guests cannot retain a credential or use a prior member's credential to extend a visit", sandbox(async (store, dir) => {
  store.bootstrap("Owner");
  const visitorInvite = store.createAccount("Visitor", "guest");
  const visitor = store.acceptInvitation(visitorInvite.account.id, visitorInvite.invitation);
  const context = { rpID: "localhost", origin: "http://localhost:3000" };
  await assert.rejects(store.beginEnrollment(visitor.session, context, true), /Re-authenticate/);
  const memberInvite = store.createAccount("Former member", "member");
  const member = store.acceptInvitation(memberInvite.account.id, memberInvite.invitation);
  store.setOwnPassphrase(member.session, "an individual member passphrase 2026");
  const code = store.issueOwnRecoveryCode(member.session);
  const file = path.join(dir, "security", "multiuser.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  // An inert credential tests the role guard only; it cannot sign a challenge.
  state.accounts.find((person: { id: string }) => person.id === memberInvite.account.id).credentials.push({
    id: "inert-role-guard", publicKey: "not-a-key", counter: 0, transports: [],
    createdAt: new Date().toISOString(), consentedAt: new Date().toISOString(),
  });
  fs.writeFileSync(file, JSON.stringify(state));
  store.updateAccount(memberInvite.account.id, { role: "guest" });
  assert.throws(() => store.authenticatePassphrase(memberInvite.account.id, "an individual member passphrase 2026"));
  await assert.rejects(store.beginPasskeyLogin(memberInvite.account.id, context), /No passkey/);
  assert.throws(() => store.recover(memberInvite.account.id, code));
  store.updateAccount(memberInvite.account.id, { role: "member" });
  assert.equal(store.recover(memberInvite.account.id, code).session.method, "recovery",
    "that account's own recovery code works after role restoration; guest has no renewable sign-in");
}));

test("relationship metadata is separate, owner can correct it, and security events require an explicit strong grant", sandbox((store) => {
  const owner = store.bootstrap("Owner");
  const aliceInvite = store.createAccount("Alice", "member");
  const bobInvite = store.createAccount("Bob", "member");
  const adminInvite = store.createAccount("Admin", "admin");
  const alice = store.acceptInvitation(aliceInvite.account.id, aliceInvite.invitation);
  store.acceptInvitation(bobInvite.account.id, bobInvite.invitation);
  const admin = store.acceptInvitation(adminInvite.account.id, adminInvite.invitation);
  const relation = store.addRelationship(aliceInvite.account.id, bobInvite.account.id, "teacher", owner.account.id);
  assert.equal(store.readRelationships(owner.account.id).length, 0, "the owner is not inferred to be a participant");
  assert.equal(store.readRelationships(owner.account.id, true)[0].id, relation.id, "only owner can manage others' labels");
  assert.throws(() => store.readRelationships(aliceInvite.account.id, true));
  assert.equal(store.readRelationships(aliceInvite.account.id)[0].label, "teacher");
  assert.throws(() => store.addRelationship(aliceInvite.account.id, bobInvite.account.id, "TEACHER"), /already exists/);
  assert.throws(() => store.removeRelationship(relation.id, alice.session));
  store.removeRelationship(relation.id, store.requireSession(owner.token));
  assert.equal(store.readRelationships(aliceInvite.account.id).length, 0);

  assert.ok(store.readSecurityAudit(store.requireSession(owner.token)).some((event) => event.action === "relationship_removed"));
  assert.equal(store.readOwnAudit(aliceInvite.account.id).some((event) => event.actor === adminInvite.account.id), false);
  assert.throws(() => store.readSecurityAudit(admin.session), /not permitted|Re-authenticate/);
  store.updateAccount(adminInvite.account.id, { allow: ["view_security_events", "manage_security_settings"] });
  assert.throws(() => store.readSecurityAudit(admin.session), /revoked/);
  assert.deepEqual(store.roles().admin, ["chat", "memory"], "an individual grant does not alter the role defaults");
  store.updateRole("member", ["chat", "manage_users", "view_security_events"]);
  assert.equal(store.ownProfile(aliceInvite.account.id)?.capabilities.includes("manage_users"), false,
    "member role policy cannot confer administration");
  assert.equal(store.ownProfile(aliceInvite.account.id)?.capabilities.includes("view_security_events"), false);
}));
