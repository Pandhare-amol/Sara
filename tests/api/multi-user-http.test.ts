import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { readSseData } from "../../src/core/models/sseStream";
import { readChatStream } from "../../src/lib/chatStream";

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}
async function freePort() {
  const { server, port } = await listen((_, res) => res.end());
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Protected HTTP server did not become ready.");
}
async function stop(child: ChildProcess | undefined) {
  child?.kill("SIGTERM");
  if (child && child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child?.exitCode === null) child.kill("SIGKILL");
}

// Local provider only: these checks validate request/response authorization and
// prompt isolation, not the correctness of a live Gemini model or real hardware.
test("opt-in HTTP mode binds user sessions to scoped chat/memories, denies unintegrated routes and mobile server", { timeout: 65_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-users-http-"));
  const prompts: string[] = [];
  let releaseRevokedStream!: () => void;
  const heldRevokedStream = new Promise<void>((resolve) => { releaseRevokedStream = resolve; });
  const provider = await listen(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body);
    const prompt = String(request.messages?.at(-1)?.content || "");
    prompts.push(prompt);
    if (request.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"SCOPE-FIRST"}}]}\n\n');
      if (prompt.includes("REVOKE_IN_FLIGHT")) await heldRevokedStream;
      res.write('data: {"choices":[{"delta":{"content":" SCOPE-FINAL"}}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Mocked model answer" } }], usage: { completion_tokens: 5 } }));
  });
  let main: ChildProcess | undefined;
  let mobile: ChildProcess | undefined;
  let logs = "";
  try {
    fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify([{ id: "desktop-legacy", title: "Owner history", messages: [{ role: "user", text: "Only owner sees this" }] }]));
    fs.writeFileSync(path.join(dir, "memories.json"), "[]");
    const port = await freePort(); const mobilePort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const secret = "a-long-owner-admin-secret-for-local-http-tests-only";
    main = spawn(process.execPath, ["--import", "tsx", "server_full.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        PORT: String(port), SARA_BIND_HOST: "127.0.0.1", SARA_SUPERVISOR: "1", SARA_DATA_DIR: dir,
        SARA_ADMIN_TOKEN: secret, SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "mocked",
        SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, SARA_AUTO_MEMORY: "false", GEMINI_API_KEY: "",
      },
    });
    main.stdout?.on("data", (data) => { logs += String(data).slice(0, 1200); });
    main.stderr?.on("data", (data) => { logs += String(data).slice(0, 1200); });
    await until(async () => (await fetch(`${base}/api/users/status`)).ok);
    const call = async (route: string, method = "GET", token = "", body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method, headers: {
        ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { "x-sara-session": token } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    };
    assert.equal((await call("/api/users/status")).body.enabled, false);
    assert.equal((await call("/api/users/bootstrap", "POST", "", { displayName: "Owner", adminSecret: "bad" })).status, 401);
    const created = await call("/api/users/bootstrap", "POST", "", { displayName: "Owner", adminSecret: secret });
    assert.equal(created.status, 201, JSON.stringify(created.body) + logs.slice(-400));
    const owner = created.body.token as string;
    assert.equal(created.body.account.id, "default-user");
    assert.equal((await call("/api/users/status")).body.enabled, true);
    for (const privatePath of ["/data/security/multiuser.json", "/data/conversations.json", `/@fs/${dir.replace(/^\//, "")}/security/multiuser.json`]) {
      const response = await fetch(`${base}${privatePath}`);
      const text = await response.text();
      assert.equal(response.status, 403, `Vite/static routing must never expose ${privatePath}`);
      assert.doesNotMatch(text, /Owner history|tokenHash|default-user/);
    }
    assert.equal((await call("/api/users/bootstrap", "POST", "", { displayName: "Imposter", adminSecret: secret })).status, 401);
    assert.equal((await call("/api/conversations", "GET")).status, 401);
    assert.equal((await call("/api/memories", "GET")).status, 401);
    const forbiddenHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/memories", headers: { Host: "attacker.example", "x-sara-session": owner } }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode || 0));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(forbiddenHost, 403);
    assert.equal((await fetch(`${base}/api/memories`, { headers: { Origin: "https://attacker.example", "x-sara-session": owner } })).status, 403);
    assert.equal((await fetch(`${base}/api/memories`, { headers: { "x-sara-access-token": secret } })).status, 401,
      "installation-wide device/remote tokens cannot sign in as a person");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Origin: base } });
    let liveOpened = false; ws.once("open", () => { liveOpened = true; ws.close(); });
    await Promise.race([
      new Promise<void>((resolve) => { ws.once("error", () => resolve()); ws.once("close", () => resolve()); }),
      new Promise<void>((resolve) => setTimeout(() => { ws.terminate(); resolve(); }, 1000)),
    ]);
    assert.equal(liveOpened, false, "Live voice cannot accept an unauthenticated socket in protected mode");
    assert.equal((await call("/api/chat", "POST", "", { text: "Who am I?" })).status, 401);
    for (const route of ["/api/identity/profiles", "/api/settings", "/api/camera/gallery", "/api/tools/metadata", "/api/admin/audit", "/api/whatsapp/history", "/api/visual/access", "/api/visual/displays"]) {
      assert.equal((await call(route, "GET", owner)).status, 403, `${route} must stay locked even for owner`);
    }
    assert.equal((await call("/api/config/apikey", "POST", owner, { apiKey: "do-not-save" })).status, 403);
    assert.equal((await call("/api/visual/access", "POST", owner,
      { confirm: true, scope: "application", application: "notepad.exe", duration_seconds: 30 })).status, 403);
    assert.equal((await call("/api/visual/observe", "POST", owner, { refresh: true })).status, 403);
    assert.equal((await call("/api/visual/describe", "POST", owner, { confirm_cloud: true })).status, 403);
    assert.equal((await call("/api/visual/tasks", "POST", owner,
      { label: "Help", expected_label: "About" })).status, 403);
    assert.equal((await call("/api/vision/screen-capture", "POST", owner, {})).status, 403);
    assert.equal((await call("/api/conversations", "GET", owner)).body[0].id, "desktop-legacy");
    assert.equal((await call("/api/users/me", "GET", "wrong")).status, 401);
    assert.deepEqual((await call("/api/users/me/passkeys", "GET", owner)).body.passkeys, []);
    assert.equal((await call("/api/users/me/passkeys/revoke", "POST", owner, { credentialId: "forged" })).status, 403);
    const inviteA = await call("/api/users", "POST", owner, { displayName: "Alice", role: "member" });
    const inviteB = await call("/api/users", "POST", owner, { displayName: "Bob", role: "member" });
    assert.equal(inviteA.status, 201); assert.equal(inviteB.status, 201);
    const aId = inviteA.body.account.id as string, bId = inviteB.body.account.id as string;
    assert.notEqual(aId, bId);
    const signA = await call("/api/users/auth/invitation", "POST", "", { userId: aId, code: inviteA.body.invitation });
    const signB = await call("/api/users/auth/invitation", "POST", "", { userId: bId, code: inviteB.body.invitation });
    assert.equal(signA.status, 200); assert.equal(signB.status, 200);
    const alice = signA.body.token as string, bob = signB.body.token as string;
    assert.equal((await call("/api/users/auth/invitation", "POST", "", { userId: aId, code: inviteA.body.invitation })).status, 401);
    assert.equal((await call("/api/users", "GET", alice)).status, 403);
    assert.equal((await call("/api/users/me", "GET", alice)).body.account.preferences.language, "en");
    const alicePrefs = await call("/api/users/me/preferences", "PATCH", alice,
      { preferences: { language: "mr", personalizedGreeting: true } });
    assert.equal(alicePrefs.body.account.preferences.language, "mr");
    assert.equal((await call("/api/users/me/preferences", "PATCH", bob,
      { userId: aId, preferences: { language: "hi" } })).body.account.id, bId,
      "an account ID supplied by the browser must never redirect a preference change");
    assert.equal((await call("/api/users/me", "GET", alice)).body.account.preferences.language, "mr");
    for (const invalid of [{ language: "zz" }, { faceRecognition: true }, { proactiveConversation: "yes" }]) {
      assert.equal((await call("/api/users/me/preferences", "PATCH", alice, { preferences: invalid })).status, 403);
    }
    assert.equal((await call("/api/users", "GET", owner)).body.accounts.some((item: any) => "preferences" in item), false,
      "the manager directory cannot return a member's private preference choices");
    assert.equal((await call("/api/users/security/activity", "GET", alice)).status, 403);
    assert.equal((await call("/api/users/security/activity", "GET", owner)).status, 200);
    const adminInvite = await call("/api/users", "POST", owner, { displayName: "Coordinator", role: "admin" });
    const adminAuth = await call("/api/users/auth/invitation", "POST", "", { userId: adminInvite.body.account.id, code: adminInvite.body.invitation });
    assert.equal(adminAuth.status, 200);
    assert.equal((await call("/api/users", "GET", adminAuth.body.token)).status, 403,
      "an admin title does not automatically grant account-management permission");
    assert.equal((await call("/api/users/security/activity", "GET", adminAuth.body.token)).status, 403);
    assert.equal((await call("/api/users/settings", "PATCH", adminAuth.body.token, { sessionIdleMinutes: 10 })).status, 403,
      "security settings need an explicit grant plus a fresh strong sign-in");
    assert.equal((await call(`/api/users/accounts/${adminInvite.body.account.id}`, "PATCH", owner,
      { allow: ["manage_users"] })).body.account.capabilities.includes("manage_users"), true);
    assert.deepEqual((await call(`/api/users/accounts/${adminInvite.body.account.id}`, "PATCH", owner,
      { role: "restricted" })).body.account.capabilities, [], "changing roles clears exceptional grants");
    const restrictedInvite = await call("/api/users", "POST", owner, { displayName: "Restricted", role: "restricted" });
    const restrictedAuth = await call("/api/users/auth/invitation", "POST", "", { userId: restrictedInvite.body.account.id, code: restrictedInvite.body.invitation });
    assert.equal(restrictedAuth.status, 200);
    assert.equal((await call("/api/chat", "POST", restrictedAuth.body.token, { text: "Denied" })).status, 403,
      "restricted accounts require an explicit chat grant");
    assert.equal((await call("/api/memories", "GET", restrictedAuth.body.token)).status, 403);
    assert.equal((await call("/api/users/me/activity", "GET", restrictedAuth.body.token)).status, 403);
    assert.equal((await call("/api/users/security/activity", "GET", restrictedAuth.body.token)).status, 403);
    assert.equal((await call("/api/users/settings", "GET", alice)).body.settings.sessionIdleMinutes, 15);
    assert.equal((await call("/api/users/settings", "PATCH", alice, { sessionIdleMinutes: 5 })).status, 403);
    assert.equal((await call("/api/users/settings", "PATCH", owner, { sessionIdleMinutes: 5 })).body.settings.sessionIdleMinutes, 5);
    assert.equal((await call("/api/users/settings", "PATCH", owner, { sessionIdleMinutes: 1 })).status, 403);
    assert.equal((await call(`/api/users/accounts/${aId}/invitation`, "POST", owner)).status, 403,
      "owner cannot replace an invitation after a user has joined");
    assert.equal((await call(`/api/users/accounts/${aId}/code`, "POST", owner, { type: "recovery" })).status, 404,
      "no owner-issued recovery endpoint may impersonate another person");
    const ownRecovery = await call("/api/users/me/recovery-code", "POST", alice);
    assert.equal(ownRecovery.status, 200);
    assert.equal((await call("/api/users/auth/recovery", "POST", "", { userId: bId, code: ownRecovery.body.code })).status, 401);
    assert.equal((await call("/api/users/me/passphrase", "POST", alice, { passphrase: "short" })).status, 403);
    assert.equal((await call("/api/users/me/passphrase", "POST", alice, { passphrase: "Alice private fallback phrase 2026" })).status, 200);
    const passwordAuth = await call("/api/users/auth/passphrase", "POST", "", { userId: aId, passphrase: "Alice private fallback phrase 2026" });
    assert.equal(passwordAuth.status, 200);
    assert.equal((await call("/api/users/me", "GET", passwordAuth.body.token)).body.account.id, aId);
    assert.equal((await call("/api/users/auth/passphrase", "POST", "", { userId: bId, passphrase: "Alice private fallback phrase 2026" })).status, 401);
    assert.equal((await call("/api/users/logout", "POST", passwordAuth.body.token)).status, 200);
    assert.equal((await call("/api/users/relationships", "POST", alice, { from: aId, to: bId, label: "teacher" })).status, 403);
    const label = await call("/api/users/relationships", "POST", owner, { from: aId, to: bId, label: "teacher" });
    assert.equal(label.status, 201);
    assert.equal((await call("/api/users/relationships", "GET", alice)).body.relationships[0].label, "teacher");
    assert.equal((await call("/api/users/relationships", "GET", owner)).body.relationships[0].id, label.body.relationship.id,
      "owner sees descriptive labels between members without seeing their private conversations");
    assert.equal((await call(`/api/users/relationships/${label.body.relationship.id}`, "DELETE", bob)).status, 403);
    const memoryA = await call("/api/memories", "POST", alice, { category: "preference", text: "Alice enjoys sea-glass green" });
    const memoryB = await call("/api/memories", "POST", bob, { category: "preference", text: "Bob enjoys mahogany red" });
    assert.equal(memoryA.status, 201, JSON.stringify(memoryA.body)); assert.equal(memoryB.status, 201);
    assert.equal((await call("/api/memories", "GET", alice)).body.length, 1);
    assert.equal((await call("/api/memories", "GET", bob)).body[0].text, "Bob enjoys mahogany red");
    const repeated = await call("/api/memories", "POST", alice, { category: "preference", text: "Alice enjoys sea-glass green" });
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.id, memoryA.body.id, "retrying an identical manual save must not duplicate memory");
    const putOwn = await call(`/api/memories/${memoryA.body.id}`, "PUT", alice,
      { category: "preference", text: "Alice enjoys sea-glass green" });
    assert.equal(putOwn.status, 200);
    assert.equal(putOwn.body.approvedByUser, true);
    const confirmOwn = await call(`/api/memories/${memoryA.body.id}/confirm`, "POST", alice);
    assert.equal(confirmOwn.status, 200);
    assert.equal(confirmOwn.body.approvedByUser, true);
    assert.equal((await call(`/api/memories/${memoryA.body.id}`, "PUT", bob,
      { category: "preference", text: "Overwrite Alice" })).status, 404);
    assert.equal((await call(`/api/memories/${memoryA.body.id}/confirm`, "POST", bob)).status, 404);
    assert.equal((await call(`/api/memories/${memoryA.body.id}/confirm`, "POST", "")).status, 401);
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, n) => call("/api/memories", "POST", alice,
      { category: "goal", text: `Alice concurrent approved fact ${n}` })));
    assert.ok(concurrent.every((item) => item.status === 201));
    assert.equal((await call("/api/memories", "GET", alice)).body.length, 7,
      "parallel approved writes must not silently erase each other's memory");
    const correctedGoal = await call(`/api/memories/${concurrent[0].body.id}`, "PUT", alice,
      { category: "goal", text: "Alice concurrent approved fact 0 corrected" });
    assert.equal(correctedGoal.status, 200);
    assert.equal(correctedGoal.body.approvedByUser, true);
    assert.equal(correctedGoal.body.text, "Alice concurrent approved fact 0 corrected");
    assert.equal((await call(`/api/memories/${memoryA.body.id}`, "PATCH", bob, { category: "goal", text: "overwrite" })).status, 404);
    assert.equal((await call(`/api/memories/${memoryA.body.id}`, "DELETE", bob)).status, 404);
    assert.deepEqual((await call("/api/memories", "GET", owner)).body, []);
    assert.equal((await call("/api/users/me/export", "GET", "")).status, 401);
    const idA = `${aId}:desktop-111`, idB = `${bId}:desktop-222`;
    assert.equal((await call("/api/conversations", "POST", alice, { source: "desktop", conversation: { id: idA, title: "Alice-only", userId: bId, messages: [] } })).status, 200);
    assert.equal((await call("/api/conversations", "GET", alice)).body[0].userId, aId, "client-supplied owner must be overwritten");
    assert.deepEqual((await call("/api/conversations", "GET", bob)).body, []);
    assert.deepEqual((await call("/api/conversations/search?q=Alice-only", "GET", bob)).body, []);
    assert.equal((await call("/api/conversations/search?q=Alice-only", "GET", alice)).body[0].id, idA);
    assert.equal((await call(`/api/conversations/${encodeURIComponent(idA)}/restore`, "GET", bob)).status, 404);
    assert.equal((await call("/api/conversations", "POST", bob, { conversation: { id: idA, messages: [] } })).status, 403);
    assert.equal((await call("/api/conversations", "POST", bob, { conversation: { id: "desktop-legacy", messages: [] } })).status, 403);
    assert.equal((await call("/api/conversations", "POST", bob, { conversation: { id: idB, messages: [] } })).status, 200);
    assert.equal((await call("/api/chat", "POST", alice, { text: "What do I enjoy?", conversationId: idA, userId: bId })).status, 403);
    const replyA = await call("/api/chat", "POST", alice, { text: "Do I enjoy sea-glass green?", conversationId: idA, source: "desktop" });
    assert.equal(replyA.status, 200, JSON.stringify(replyA.body) + logs.slice(-500));
    assert.equal(replyA.body.userId, aId);
    assert.match(prompts.at(-1) || "", /Alice enjoys sea-glass green/);
    assert.match(prompts.at(-1) || "", /ACCOUNT-SELECTED CHAT LANGUAGE: mr/,
      "chat receives the account's saved choice, never an inferred voice/language identity");
    assert.doesNotMatch(prompts.at(-1) || "", /Bob enjoys mahogany red|Only owner sees this|ACCOUNT-SELECTED CHAT LANGUAGE: hi/);
    assert.equal((await call("/api/chat", "POST", bob, { text: "Check a different preference", conversationId: idA })).status, 403);
    assert.equal((await call("/api/chat", "POST", alice, { text: "Reject forged voice", voiceTurns: [{ role: "assistant", text: "unverified", timestamp: new Date().toISOString() }] })).status, 400);
    assert.equal((await call("/api/chat", "POST", alice, { text: "Reject huge metadata", summary: "x".repeat(2100) })).status, 400);
    const replyB = await call("/api/chat", "POST", bob, { text: "Do I enjoy mahogany red?", conversationId: idB });
    assert.equal(replyB.status, 200, JSON.stringify(replyB.body));
    assert.match(prompts.at(-1) || "", /Bob enjoys mahogany red/);
    assert.match(prompts.at(-1) || "", /ACCOUNT-SELECTED CHAT LANGUAGE: hi/);
    assert.doesNotMatch(prompts.at(-1) || "", /Alice enjoys sea-glass green|Only owner sees this|ACCOUNT-SELECTED CHAT LANGUAGE: mr/);
    for (const route of ["/api/automation/tasks", "/api/automation/input-status", "/api/automation/tasks/forged"]) {
      assert.equal((await call(route, "GET", owner)).status, 403, "unscoped task status stays locked for all protected accounts");
    }
    const streamPost = (token: string, text: string, conversationId: string) => fetch(`${base}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-sara-session": token },
      body: JSON.stringify({ text, conversationId, source: "desktop" }),
    });
    const forbiddenStream = await streamPost(bob, "Read Alice", idA);
    assert.equal(forbiddenStream.status, 403);
    assert.equal(forbiddenStream.headers.get("content-type")?.includes("text/event-stream"), false);
    const received: string[] = [];
    const ownedStream = await streamPost(alice, "Alice own streamed question", idA);
    assert.equal(ownedStream.status, 200, logs.slice(-500));
    const ownedDone = await readChatStream(ownedStream, (delta) => received.push(delta));
    assert.deepEqual(received, ["SCOPE-FIRST", " SCOPE-FINAL"]);
    assert.equal(ownedDone.userId, aId);
    assert.equal(ownedDone.conversationId, idA);
    assert.match(prompts.at(-1) || "", /Alice enjoys sea-glass green/);
    assert.doesNotMatch(prompts.at(-1) || "", /Bob enjoys mahogany red/);
    const exportedA = await call("/api/users/me/export", "GET", alice);
    assert.equal(exportedA.status, 200, JSON.stringify(exportedA.body));
    assert.equal(exportedA.body.account.id, aId);
    assert.deepEqual(exportedA.body.account.preferences,
      { language: "mr", personalizedGreeting: true, proactiveConversation: false });
    assert.equal(exportedA.body.memories.length, 7);
    assert.equal(exportedA.body.conversations[0].id, idA);
    assert.doesNotMatch(JSON.stringify(exportedA.body), /Bob enjoys mahogany red|Only owner sees this|passphraseHash|recoveryHash|tokenHash/);
    const exportedB = await call("/api/users/me/export?userId=" + aId, "GET", bob);
    assert.equal(exportedB.status, 200);
    assert.equal(exportedB.body.account.id, bId, "client-selected user ID cannot change export ownership");
    assert.doesNotMatch(JSON.stringify(exportedB.body), /Alice enjoys sea-glass green|Alice-only/);
    const aAudit = await call("/api/users/me/activity", "GET", alice);
    assert.equal(aAudit.status, 200);
    assert.ok(aAudit.body.events.some((event: any) => event.action === "self_passphrase_changed_and_other_sessions_revoked"));
    assert.equal((await call("/api/users/me/sessions", "GET", alice)).body.sessions.length, 1);
    assert.doesNotMatch(JSON.stringify(aAudit.body), /tokenHash|Alice private fallback phrase 2026/);
    assert.equal((await call("/api/users/me/activity", "GET", bob)).body.events.some((e: any) => e.subject === aId), false,
      "a member's audit view must not reveal another member's activity");
    const systemAudit = await call("/api/users/security/activity", "GET", owner);
    assert.equal(systemAudit.status, 200);
    assert.ok(systemAudit.body.events.some((e: any) => e.actor === aId && e.action === "self_preferences_updated"));
    assert.doesNotMatch(JSON.stringify(systemAudit.body), /Alice enjoys sea-glass green|passphraseHash|tokenHash/);
    const transientAuth = await call("/api/users/auth/passphrase", "POST", "",
      { userId: aId, passphrase: "Alice private fallback phrase 2026" });
    assert.equal(transientAuth.status, 200);
    const inFlight = await streamPost(transientAuth.body.token, "REVOKE_IN_FLIGHT", idA);
    assert.equal(inFlight.status, 200);
    const observed: Array<{ event: string; data: any }> = [];
    const reading = readSseData(inFlight.body!, (raw, event) => observed.push({ event: event || "", data: JSON.parse(raw) }));
    await until(async () => observed.some((item) => item.event === "text"), 4_000);
    assert.equal((await call("/api/users/logout", "POST", transientAuth.body.token)).status, 200);
    releaseRevokedStream();
    await reading;
    assert.equal(observed.at(-1)?.event, "error", "revoked streams cannot report persisted completion");
    assert.equal(observed.at(-1)?.data.partial, true);
    assert.equal(observed.some((item) => item.event === "done" || item.data.text === " SCOPE-FINAL"), false);
    const restoredAfterRevoke = await call(`/api/conversations/${encodeURIComponent(idA)}/restore`, "GET", alice);
    assert.equal(restoredAfterRevoke.body.conversation.messages.some((item: any) => item.text === "REVOKE_IN_FLIGHT"), false,
      "in-flight text must not persist after session revocation");
    assert.equal((await call(`/api/users/relationships/${label.body.relationship.id}`, "DELETE", owner)).status, 200);
    assert.deepEqual((await call("/api/users/relationships", "GET", alice)).body.relationships, []);
    const guestInvite = await call("/api/users", "POST", owner, { displayName: "Guest", role: "guest" });
    const guestAuth = await call("/api/users/auth/invitation", "POST", "", { userId: guestInvite.body.account.id, code: guestInvite.body.invitation });
    const guest = guestAuth.body.token as string;
    assert.equal((await call("/api/memories", "GET", guest)).status, 403);
    assert.equal((await call(`/api/memories/${memoryA.body.id}/confirm`, "POST", guest)).status, 403);
    assert.equal((await call(`/api/memories/${memoryA.body.id}?source=mobile`, "PUT", alice,
      { category: "goal", text: "device cannot claim Alice's session" })).status, 403);
    assert.equal((await call("/api/conversations", "GET", guest)).status, 403);
    assert.equal((await call("/api/users/me/export", "GET", guest)).status, 403);
    assert.equal((await call("/api/users/me/activity", "GET", guest)).status, 403);
    assert.equal((await call("/api/users/me/preferences", "PATCH", guest, { preferences: { language: "hi" } })).status, 403);
    assert.equal((await call("/api/users/me", "PATCH", guest, { displayName: "Permanent guest" })).status, 403);
    const guestReply = await call("/api/chat", "POST", guest, { text: "Hello as guest" });
    assert.equal(guestReply.status, 200); assert.equal(guestReply.body.temporary, true);
    assert.equal(fs.existsSync(path.join(dir, "users", guestInvite.body.account.id)), false, "guest chat is never persisted");
    assert.equal((await call("/api/users/accounts/" + guestInvite.body.account.id, "PATCH", owner, { disabled: true })).status, 200);
    assert.equal((await call("/api/chat", "POST", guest, { text: "Should be locked" })).status, 401);
    assert.equal((await call("/api/users/logout", "POST", alice)).status, 200);
    assert.equal((await call("/api/memories", "GET", alice)).status, 401);
    assert.equal((await call("/api/conversations", "GET", bob)).body[0].id, idB);
    assert.equal((await call("/api/users/accounts/" + bId, "PATCH", bob, { role: "admin" })).status, 403);
    assert.equal((await call("/api/users/accounts/" + bId, "PATCH", owner, { role: "restricted" })).status, 200);
    assert.equal((await call("/api/memories", "GET", bob)).status, 401, "role changes revoke sessions");
    const newInvite = await call("/api/users", "POST", owner, { displayName: "Session test", role: "member" });
    const newAuth = await call("/api/users/auth/invitation", "POST", "", { userId: newInvite.body.account.id, code: newInvite.body.invitation });
    assert.equal(newAuth.status, 200);
    assert.equal((await call(`/api/users/accounts/${newInvite.body.account.id}/revoke-sessions`, "POST", newAuth.body.token)).status, 403);
    assert.equal((await call("/api/users/accounts/default-user/revoke-sessions", "POST", owner)).status, 403);
    const stopped = await call(`/api/users/accounts/${newInvite.body.account.id}/revoke-sessions`, "POST", owner);
    assert.equal(stopped.body.revoked, 1);
    assert.equal((await call("/api/users/me", "GET", newAuth.body.token)).status, 401);
    assert.equal((await call("/api/users", "GET", owner)).body.accounts.find((p: any) => p.id === newInvite.body.account.id).activeSessions, 0);
    assert.equal((await call("/api/users/auth/owner", "POST", "", { adminSecret: "not the secret" })).status, 401);
    const extraOwner = await call("/api/users/auth/owner", "POST", "", { adminSecret: secret });
    assert.equal(extraOwner.status, 200);
    assert.equal((await call("/api/users/me/sessions", "GET", extraOwner.body.token)).body.sessions.length, 2);
    assert.equal((await call("/api/users/me/revoke-other-sessions", "POST", extraOwner.body.token)).status, 200);
    assert.equal((await call("/api/users/me", "GET", owner)).status, 401);
    assert.equal((await call("/api/users/me", "GET", extraOwner.body.token)).status, 200);
    const stateFile = path.join(dir, "security", "multiuser.json");
    const aged = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const idleSeenAt = Date.now() - 4 * 60_000;
    aged.sessions.find((s: any) => s.userId === "default-user").lastSeenAt = idleSeenAt;
    fs.writeFileSync(stateFile, JSON.stringify(aged));
    assert.equal((await call("/api/users/me", "GET", extraOwner.body.token)).status, 200);
    assert.equal((await call("/api/users/me", "GET", extraOwner.body.token)).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).sessions.find((s: any) => s.userId === "default-user").lastSeenAt, idleSeenAt,
      "polling the real /me route must not reset inactivity");
    aged.sessions.find((s: any) => s.userId === "default-user").lastSeenAt = Date.now() - 6 * 60_000;
    fs.writeFileSync(stateFile, JSON.stringify(aged));
    assert.equal((await call("/api/users/me", "GET", extraOwner.body.token)).status, 401);
    // Mobile routes must reject a device-only bearer even when they run as a separate process.
    mobile = spawn(process.execPath, ["--import", "tsx", "mobile_server.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        MOBILE_SERVER_PORT: String(mobilePort), SARA_DATA_DIR: dir, SARA_MOBILE_SERVER_HOST: "127.0.0.1",
        SARA_TEXT_PROVIDER: "openai-compatible", SARA_TEXT_MODEL: "mocked", SARA_TEXT_API_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      },
    });
    await until(async () => (await fetch(`http://127.0.0.1:${mobilePort}/api/config`)).status === 403);
    assert.equal((await fetch(`http://127.0.0.1:${mobilePort}/api/memories`, { headers: { "x-sara-session": owner } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${mobilePort}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "mobile" }) })).status, 403);
  } finally {
    releaseRevokedStream();
    await Promise.all([stop(main), stop(mobile)]);
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
