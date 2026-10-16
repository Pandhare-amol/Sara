import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_SWITCH_KEY, apiFetch, clearUserSession, setUserSession, userSessionToken, activeUserId } from "../../src/lib/userSession";

function storage() {
  const values = new Map<string, string>();
  return {
    setItem(key: string, value: string) { values.set(key, value); },
    getItem(key: string) { return values.get(key) ?? null; },
    removeItem(key: string) { values.delete(key); },
  };
}

test("switching users discards unscoped browser caches, settings and experimental voice samples", () => {
  const localStorage = storage(); const sessionStorage = storage();
  const oldWindow = (globalThis as any).window;
  (globalThis as any).window = { localStorage, sessionStorage };
  try {
    localStorage.setItem("sara.conversationId", "old-owner-conversation");
    localStorage.setItem("sara_desktop_conversations", "private transcript");
    localStorage.setItem("sara.settings.v2", "old personal settings");
    localStorage.setItem("sara.voiceProfile.v1", "old voice sample");
    sessionStorage.setItem("sara.adminToken", "legacy-admin-token");
    const token = "A".repeat(43);
    setUserSession(token, "u-" + "b".repeat(32));
    assert.equal(activeUserId(), "u-" + "b".repeat(32));
    for (const key of ["sara.conversationId", "sara_desktop_conversations", "sara.settings.v2", "sara.voiceProfile.v1"]) {
      assert.equal(localStorage.getItem(key), null, `${key} must not follow a different account`);
    }
    assert.equal(sessionStorage.getItem("sara.adminToken"), null);
    assert.equal(userSessionToken(), token);
    assert.ok(localStorage.getItem(ACCOUNT_SWITCH_KEY), "other tabs receive an account-switch notice");
    clearUserSession();
    assert.equal(activeUserId(), null);
    assert.equal(userSessionToken(), null);
  } finally { (globalThis as any).window = oldWindow; }
});

test("API helper sends only same-origin account requests and forbids credentialed redirects", async () => {
  const oldWindow = (globalThis as any).window;
  const oldFetch = globalThis.fetch;
  const sessionStorage = storage();
  (globalThis as any).window = { localStorage: storage(), sessionStorage };
  const token = "C".repeat(43);
  const requests: { url: string; init: RequestInit }[] = [];
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  try {
    setUserSession(token, "default-user");
    assert.throws(() => apiFetch("https://another.site/api/private"), /same-origin/);
    assert.throws(() => apiFetch("/other/path"), /same-origin/);
    await apiFetch("/api/memories", { redirect: "follow", mode: "cors" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/memories");
    assert.equal(new Headers(requests[0].init.headers).get("x-sara-session"), token);
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.mode, "same-origin");
  } finally { (globalThis as any).window = oldWindow; (globalThis as any).fetch = oldFetch; }
});
