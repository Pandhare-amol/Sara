import express, { type Request, type RequestHandler } from "express";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { isLoopbackAddress, isLoopbackHost } from "./requestGuards";
import { MultiUserStore, type UserCapability, type UserRole, type UserSession } from "./multiUserStore";

/** Protected mode is a positive allowlist. Unmigrated APIs (tools, camera, settings,
 * admin, webhook, cognitive, mobile, etc.) are denied, even to the owner, until
 * they have explicit per-user scopes AND enforce them in their trusted entry points.
 */
export function protectedApiGate(store: MultiUserStore): RequestHandler {
  return (req, res, next) => {
    if (!store.isEnabled()) return next();
    res.setHeader("Cache-Control", "no-store, private");
    const route = req.path;
    if (route === "/users/status" && req.method === "GET") return next();
    if (route === "/users/bootstrap" && req.method === "POST") return next();
    try { if (!store.isInitialized()) return res.status(503).json({ error: "Multi-user setup or recovery is required." }); }
    catch { return res.status(503).json({ error: "Account store unavailable; protected APIs are locked." }); }
    if (route === "/users" || route.startsWith("/users/")) return next();
    let required: UserCapability | null = null;
    if (route === "/chat" && req.method === "POST") required = "chat";
    if (route === "/memories" || /^\/memories\/[^/]+(?:\/confirm)?$/.test(route)) required = "memory";
    if (route === "/conversations" || route === "/conversations/search" || /^\/conversations\/[^/]+(?:\/restore)?$/.test(route)) required = "chat";
    if ((route === "/config" || route === "/models/status") && req.method === "GET") required = "chat";
    if (!required) return res.status(403).json({ error: "This API is not scoped for multiple users yet." });
    if (req.query.source === "mobile" || req.body?.source === "mobile") {
      return res.status(403).json({ error: "Companion-device identity is not bound to a named user yet." });
    }
    const allowedMethods = route === "/chat" ? ["POST"] : route === "/config" || route === "/models/status" || route.endsWith("/restore") || route.endsWith("/search")
      ? ["GET"] : route === "/memories" ? ["GET", "POST"] : /^\/memories\/[^/]+\/confirm$/.test(route) ? ["POST"]
      : route.startsWith("/memories/") ? ["PUT", "PATCH", "DELETE"] : route === "/conversations" ? ["GET", "POST"] : ["DELETE"];
    if (!allowedMethods.includes(req.method)) return res.status(403).json({ error: "Method is not available in protected mode." });
    try {
      const session = sessionFromRequest(store, req);
      if (!store.has(session, required)) return res.status(403).json({ error: "This account lacks the required permission." });
      if (session.role === "guest" && route.startsWith("/conversations")) return res.status(403).json({ error: "Guest conversations are temporary; use the guest chat panel." });
      return next();
    } catch { return res.status(401).json({ error: "Sign in to continue." }); }
  };
}

export function sessionFromRequest(store: MultiUserStore, req: Request, activity = true): UserSession {
  if (!store.isEnabled()) throw new Error("Multi-user mode is not active.");
  const token = req.headers["x-sara-session"];
  return store.requireSession(typeof token === "string" ? token : "", { activity });
}

function webauthnContext(req: Request): { rpID: string; origin: string } {
  const origin = req.headers.origin;
  if (typeof origin !== "string") throw new Error("Passkeys require a browser Origin.");
  const parsed = new URL(origin);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))) {
    throw new Error("Passkeys require HTTPS or local http://localhost.");
  }
  const rpID = String(process.env.SARA_WEBAUTHN_RP_ID || parsed.hostname).toLowerCase();
  if (isIP(rpID) || (parsed.hostname !== rpID && !parsed.hostname.endsWith(`.${rpID}`))) {
    throw new Error("Passkey RP ID must be a DNS host matching the browser origin.");
  }
  return { rpID, origin: parsed.origin };
}

/** All auth routes use explicit secrets in the request body or platform WebAuthn.
 * Neither the remote-access token nor the old admin passkey is a named user.
 */
export function createMultiUserRouter(store: MultiUserStore, getOwnerSecret: () => string, onBootstrap?: () => void) {
  const router = express.Router();
  const failures = new Map<string, { count: number; reset: number }>();
  const limited = (req: Request): boolean => {
    const now = Date.now();
    for (const [key, value] of failures) if (value.reset <= now) failures.delete(key);
    const key = String(req.socket.remoteAddress || "unknown").slice(0, 128);
    return (failures.get(key)?.count || 0) >= 8;
  };
  const failed = (req: Request) => {
    const key = String(req.socket.remoteAddress || "unknown").slice(0, 128);
    const current = failures.get(key);
    failures.set(key, { count: (current?.count || 0) + 1, reset: current?.reset || Date.now() + 5 * 60_000 });
    if (failures.size > 512) failures.delete(failures.keys().next().value!);
  };
  const authError = (res: express.Response, error: unknown, status = 400) =>
    res.status(status).json({ error: error instanceof Error ? error.message : "Request denied." });
  const login = (req: Request, res: express.Response, action: () => unknown) => {
    if (limited(req)) return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    try { const result = action(); failures.delete(String(req.socket.remoteAddress || "unknown").slice(0, 128)); return res.json(result); }
    catch { failed(req); return res.status(401).json({ error: "Authentication failed." }); }
  };
  const session = (req: Request) => sessionFromRequest(store, req);
  const manager = (req: Request, fresh = false) => {
    const user = session(req);
    if (!store.has(user, "manage_users") || user.role === "guest") throw new Error("User management is not permitted.");
    if (fresh) store.requireFresh(user);
    return user;
  };

  router.get("/status", (_req, res) => {
    try { return res.json({ enabled: store.isEnabled(), initialized: store.isEnabled() && store.isInitialized(),
      ownerSecretConfigured: getOwnerSecret().length >= 32 }); }
    catch { return res.status(503).json({ enabled: true, initialized: false, error: "Account store unavailable; access locked." }); }
  });
  router.post("/bootstrap", (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return res.status(403).json({ error: "Set up accounts locally." });
    if (limited(req)) return res.status(429).json({ error: "Too many attempts." });
    const expected = getOwnerSecret();
    try {
      if (expected.length < 32 || !req.body || typeof req.body.adminSecret !== "string" ||
          !storeSecretEqual(expected, req.body.adminSecret)) throw new Error("Owner secret unavailable or invalid.");
      const result = store.bootstrap(req.body.displayName);
      onBootstrap?.(); // terminate pre-existing unscoped Live sockets immediately
      return res.status(201).json(result);
    } catch { failed(req); return res.status(401).json({ error: "Owner verification or account setup failed. Check the configured admin secret and account store." }); }
  });
  router.post("/auth/owner", (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return res.status(403).json({ error: "Owner secret sign-in is local-only." });
    return login(req, res, () => store.authenticateOwner(req.body?.adminSecret, getOwnerSecret()));
  });
  router.post("/auth/passphrase", (req, res) => login(req, res, () => store.authenticatePassphrase(req.body?.userId, req.body?.passphrase)));
  router.post("/auth/invitation", (req, res) => login(req, res, () => store.acceptInvitation(req.body?.userId, req.body?.code)));
  router.post("/auth/recovery", (req, res) => login(req, res, () => store.recover(req.body?.userId, req.body?.code)));
  router.post("/auth/passkey/options", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Too many attempts." });
    try { return res.json(await store.beginPasskeyLogin(req.body?.userId, webauthnContext(req))); }
    catch { failed(req); return res.status(400).json({ error: "No available passkey sign-in for that account or origin." }); }
  });
  router.post("/auth/passkey/verify", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Too many attempts." });
    try { const result = await store.finishPasskeyLogin(req.body?.ceremonyId, req.body?.response);
      failures.delete(String(req.socket.remoteAddress || "unknown").slice(0, 128)); return res.json(result); }
    catch { failed(req); return res.status(401).json({ error: "Passkey verification failed." }); }
  });
  router.post("/passkeys/enroll/options", async (req, res) => {
    try { return res.json(await store.beginEnrollment(session(req), webauthnContext(req), req.body?.consent === true)); }
    catch (error) { return authError(res, error, 400); }
  });
  router.post("/passkeys/enroll/verify", async (req, res) => {
    try { return res.json({ account: await store.finishEnrollment(session(req), req.body?.ceremonyId, req.body?.response) }); }
    catch (error) { return authError(res, error, 400); }
  });
  router.get("/me/passkeys", (req, res) => {
    try { return res.json({ passkeys: store.ownPasskeys(sessionFromRequest(store, req, false).userId) }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.post("/me/passkeys/revoke", (req, res) => {
    try { store.revokeOwnPasskey(session(req), req.body?.credentialId); return res.json({ ok: true, locked: true }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/me", (req, res) => {
    try { const user = sessionFromRequest(store, req, false); return res.json({ account: store.ownProfile(user.userId),
      expiresAt: user.expiresAt, freshUntil: user.freshUntil, authMethod: user.method }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.post("/logout", (req, res) => {
    try { session(req); store.revoke(String(req.headers["x-sara-session"])); return res.json({ ok: true }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.get("/me/sessions", (req, res) => {
    try { return res.json({ sessions: store.ownSessions(sessionFromRequest(store, req, false)) }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.post("/me/revoke-other-sessions", (req, res) => {
    try { store.revokeOtherSessions(session(req)); return res.json({ ok: true }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/me/activity", (req, res) => {
    try { const user = sessionFromRequest(store, req, false);
      if (user.role === "restricted" || user.role === "guest") throw new Error("Activity history is not available to this role.");
      return res.json({ events: store.readOwnAudit(user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/security/activity", (req, res) => {
    try { return res.json({ events: store.readSecurityAudit(sessionFromRequest(store, req, false)) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.patch("/me", (req, res) => {
    try { const user = session(req);
      if (user.role === "guest") throw new Error("Guest profile changes cannot be saved.");
      return res.json({ account: store.updateProfile(user.userId, req.body?.displayName) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.patch("/me/preferences", (req, res) => {
    try { return res.json({ account: store.updatePreferences(session(req), req.body?.preferences) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/", (req, res) => {
    try { manager(req); return res.json({ accounts: store.list(), roles: store.roles() }); }
    catch { return res.status(403).json({ error: "User management is not permitted." }); }
  });
  router.post("/", (req, res) => {
    try { const user = manager(req, true);
      if (user.role !== "owner" && user.role !== "admin") throw new Error("Role cannot create accounts.");
      const requested = req.body?.role as UserRole;
      if (user.role === "admin" && requested === "admin") throw new Error("Only the owner can assign admin roles.");
      return res.status(201).json(store.createAccount(req.body?.displayName, requested, user.userId)); }
    catch (error) { return authError(res, error, 403); }
  });
  router.patch("/accounts/:id", (req, res) => {
    try { const user = manager(req, true); if (user.role !== "owner") throw new Error("Only the owner can change permissions.");
      const { role, disabled, allow, deny } = req.body || {};
      return res.json({ account: store.updateAccount(req.params.id, { role, disabled, allow, deny }, user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.post("/accounts/:id/revoke-sessions", (req, res) => {
    try { const user = manager(req, true);
      if (user.role !== "owner") throw new Error("Only the owner can revoke another account's sessions.");
      return res.json({ revoked: store.revokeAccountSessions(user, req.params.id) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.post("/accounts/:id/invitation", (req, res) => {
    try { const user = manager(req, true);
      if (user.role !== "owner") throw new Error("Only the owner can replace an unaccepted invitation.");
      return res.json({ code: store.rotateInvitation(req.params.id, user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.post("/me/recovery-code", (req, res) => {
    try { return res.json({ code: store.issueOwnRecoveryCode(session(req)) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.post("/me/passphrase", (req, res) => {
    try { store.setOwnPassphrase(session(req), req.body?.passphrase); return res.json({ ok: true }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/settings", (req, res) => {
    try { sessionFromRequest(store, req, false); return res.json({ settings: store.systemSettings() }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.patch("/settings", (req, res) => {
    try { const user = session(req);
      if (!store.has(user, "manage_security_settings") || (user.role !== "owner" && user.role !== "admin")) {
        throw new Error("Security settings require an explicit grant.");
      }
      store.requireFresh(user);
      return res.json({ settings: store.updateSystemSettings(req.body?.sessionIdleMinutes, user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/roles", (req, res) => {
    try { session(req); return res.json({ roles: store.roles() }); }
    catch { return res.status(401).json({ error: "Sign in to continue." }); }
  });
  router.patch("/roles/:role", (req, res) => {
    try { const user = manager(req, true); if (user.role !== "owner") throw new Error("Only the owner can edit roles.");
      return res.json({ roles: store.updateRole(req.params.role as UserRole, req.body?.capabilities, user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.get("/relationships", (req, res) => {
    try { const user = session(req);
      return res.json({ relationships: store.readRelationships(user.userId, user.role === "owner") }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.post("/relationships", (req, res) => {
    try { const user = manager(req, true); if (user.role !== "owner") throw new Error("Only the owner can label relationships.");
      return res.status(201).json({ relationship: store.addRelationship(req.body?.from, req.body?.to, req.body?.label, user.userId) }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.delete("/relationships/:id", (req, res) => {
    try { const user = manager(req, true); if (user.role !== "owner") throw new Error("Only the owner can remove relationship labels.");
      store.removeRelationship(req.params.id, user); return res.json({ ok: true }); }
    catch (error) { return authError(res, error, 403); }
  });
  router.use((_req, res) => res.status(404).json({ error: "Unknown account endpoint." }));
  return router;
}

function storeSecretEqual(expected: string, supplied: string): boolean {
  if (supplied.length > 512 || supplied.length < 32) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(supplied).digest();
  return crypto.timingSafeEqual(a, b);
}
