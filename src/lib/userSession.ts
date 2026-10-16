import { setVisualToken } from "./visualClient";

const TOKEN_KEY = "sara.userSession";
const USER_KEY = "sara.activeUserId";
export const ACCOUNT_SWITCH_KEY = "sara.accountSwitchAt";

function notifyOtherTabs(): void {
  try { window.localStorage.setItem(ACCOUNT_SWITCH_KEY, `${Date.now()}-${Math.random()}`); }
  catch { /* Polling still detects server-side expiry when storage is unavailable. */ }
}

export function activeUserId(): string | null {
  try { return window.sessionStorage.getItem(USER_KEY); } catch { return null; }
}
export function userSessionToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** No token is ever put in a URL, localStorage, or sent to a non-API origin. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!input.startsWith("/api/")) throw new Error("Only same-origin SARA API paths may carry account credentials.");
  const token = userSessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("x-sara-session", token);
  // A compromised endpoint must not redirect a custom session header to an
  // attacker-controlled origin; account requests never follow redirects.
  return fetch(input, { ...init, headers, redirect: "error", mode: "same-origin" });
}

export function setUserSession(token: string, userId: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^(default-user|u-[a-f0-9]{32})$/.test(userId)) {
    throw new Error("Invalid account session.");
  }
  clearBrowserConversationContext();
  window.sessionStorage.setItem(TOKEN_KEY, token);
  window.sessionStorage.setItem(USER_KEY, userId);
  notifyOtherTabs();
}

export function clearBrowserConversationContext(): void {
  setVisualToken(null);
  try {
    // The old single-user renderer persisted conversation snapshots in localStorage.
    // The server still owns the original records; delete only these browser caches.
    window.localStorage.removeItem("sara.conversationId");
    window.localStorage.removeItem("sara_desktop_conversations");
    // Legacy browser-wide preferences and experimental voice fingerprints have
    // no account owner. Never leave them readable after a protected switch.
    window.localStorage.removeItem("sara.settings.v2");
    window.localStorage.removeItem("sara.voiceProfile.v1");
  } catch { /* Browser storage may be disabled. */ }
  try {
    window.sessionStorage.removeItem("sara.adminToken");
    window.sessionStorage.removeItem("sara.adminPasskeySession");
  } catch { /* Browser storage may be disabled. */ }
}

export function clearUserSession(notify = true): void {
  try { window.sessionStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(USER_KEY); } catch {}
  clearBrowserConversationContext();
  if (notify) notifyOtherTabs();
}
