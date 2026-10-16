import { useCallback, useEffect, useState, type ReactNode } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { CircleUserRound, KeyRound, LockKeyhole, MessageCircle, Plus, ShieldCheck, Users, X } from "lucide-react";
import { ACCOUNT_SWITCH_KEY, apiFetch, clearUserSession, setUserSession, userSessionToken } from "../lib/userSession";

type Capability = "chat" | "memory" | "manage_users" | "manage_security_settings" | "view_security_events";
type Role = "owner" | "admin" | "member" | "restricted" | "guest";
interface Preferences { language: string; personalizedGreeting: boolean; proactiveConversation: boolean }
interface Account {
  id: string; displayName: string; role: Role; disabled: boolean; hasPasskey: boolean; hasPassphrase: boolean; activatedAt?: string;
  capabilities: Capability[]; allow: Capability[]; deny: Capability[]; createdAt: string;
  lastUsedAt?: string; activeSessions: number; preferences?: Preferences;
}
interface Status { enabled: boolean; initialized: boolean; ownerSecretConfigured: boolean; error?: string }
type Tab = "dashboard" | "people" | "roles" | "relationships" | "profile" | "security" | "activity" | "systemActivity" | "data";
const roles: Role[] = ["owner", "admin", "member", "restricted", "guest"];
const permissions: Capability[] = ["chat", "memory", "manage_users", "manage_security_settings", "view_security_events"];
const administrativePermissions: Capability[] = ["manage_users", "manage_security_settings", "view_security_events"];
const languages = [
  { code: "en", name: "English" }, { code: "hi", name: "Hindi" }, { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" }, { code: "bn", name: "Bengali" }, { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" }, { code: "kn", name: "Kannada" }, { code: "ml", name: "Malayalam" },
  { code: "pa", name: "Punjabi" },
];
const relationshipOptions = ["mother", "father", "brother", "sister", "husband", "wife", "child", "friend", "teacher", "student", "other"];

async function jsonRequest(url: string, method: string, data?: unknown): Promise<any> {
  const response = await apiFetch(url, {
    method, cache: "no-store", headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request denied (${response.status}).`);
  return result;
}

/** A gated shell: protected UI is never mounted until a server-verified session exists. */
export function UserAccess({ legacyWorkspace }: { legacyWorkspace: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [ownerSecret, setOwnerSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signInId, setSignInId] = useState("");
  const [oneTimeCode, setOneTimeCode] = useState("");
  const [signInPassphrase, setSignInPassphrase] = useState("");
  const [platformAvailable, setPlatformAvailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/users/status", { cache: "no-store" });
      const info = await response.json() as Status;
      setStatus(info);
      const token = userSessionToken();
      if (info.enabled && info.initialized && token) {
        try { const me = await jsonRequest("/api/users/me", "GET");
          if (userSessionToken() === token) setAccount(me.account);
        } catch { if (userSessionToken() === token) { clearUserSession(); setAccount(null); } }
      } else if (info.enabled) setAccount(null);
    } catch { setStatus({ enabled: true, initialized: false, ownerSecretConfigured: false, error: "Account service unavailable; access remains locked." }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.error) return;
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [status?.error, refresh]);
  useEffect(() => {
    // Tabs can share an older copied sessionStorage when a browser tab is
    // duplicated. Switching in one tab must hide the other tab's old workspace.
    const switched = (event: StorageEvent) => {
      if (event.key !== ACCOUNT_SWITCH_KEY) return;
      clearUserSession(false); setAccount(null); setShowManager(false); setNotice("Account changed in another tab. Sign in again.");
    };
    window.addEventListener("storage", switched);
    return () => window.removeEventListener("storage", switched);
  }, []);
  useEffect(() => {
    if (typeof PublicKeyCredential === "undefined" || !window.isSecureContext) return;
    void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setPlatformAvailable).catch(() => setPlatformAvailable(false));
  }, []);
  useEffect(() => {
    if (!status?.enabled || !account) return;
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [status?.enabled, account?.id, refresh]);

  const enter = async (result: any) => {
    const id = result?.session?.userId || result?.account?.id;
    if (typeof result?.token !== "string" || typeof id !== "string") throw new Error("Sign-in did not create a user session.");
    setUserSession(result.token, id);
    const verified = await jsonRequest("/api/users/me", "GET");
    setAccount(verified.account);
    setStatus((old) => old ? { ...old, enabled: true, initialized: true } : old);
    setNotice(""); setOwnerSecret(""); setOneTimeCode(""); setSignInPassphrase(""); setShowSetup(false); setShowManager(false);
  };
  const action = async (task: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await task(); } catch (error) { setNotice(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(false); }
  };
  const signOut = () => {
    const token = userSessionToken();
    clearUserSession(); setAccount(null); setShowManager(false); setNotice("");
    // Clear the private workspace immediately, even when the network stalls.
    // The captured token is used only for a same-origin best-effort revocation.
    if (token) void fetch("/api/users/logout", { method: "POST", cache: "no-store",
      mode: "same-origin", redirect: "error", headers: { "x-sara-session": token } }).catch(() => {});
  };
  const signInPasskey = () => action(async () => {
    if (!platformAvailable) throw new Error("No verified platform passkey is available in this browser. Use your personal passphrase, one-time code, or local owner sign-in.");
    const started = await jsonRequest("/api/users/auth/passkey/options", "POST", { userId: signInId.trim() });
    const response = await startAuthentication({ optionsJSON: started.options });
    await enter(await jsonRequest("/api/users/auth/passkey/verify", "POST", { ceremonyId: started.ceremonyId, response }));
  });

  if (status === null) return <div className="min-h-screen bg-[#080b18] text-slate-200 grid place-items-center">Checking SARA account protection…</div>;
  if (!status.enabled && !showSetup) return <>
    {legacyWorkspace}
    <button type="button" onClick={() => setShowSetup(true)} className="fixed z-[120] top-3 right-3 px-3 py-2 rounded-xl bg-slate-900/90 border border-cyan-400/40 text-cyan-100 text-xs shadow-xl hover:bg-slate-800" aria-label="Set up secure user accounts">
      <Users className="inline size-4 mr-2" /> Secure users
    </button>
  </>;

  if (status.enabled && status.initialized && account && !showManager) return <>
    {account.role === "owner" ? legacyWorkspace : <SecureChat account={account} onSessionLost={() => { clearUserSession(); setAccount(null); }} />}
    <div className="fixed z-[120] right-3 top-3 max-w-[min(90vw,420px)] flex items-center gap-2 rounded-2xl bg-[#0b1429]/95 border border-cyan-400/35 px-3 py-2 shadow-2xl text-xs text-slate-100">
      <ShieldCheck className="size-4 text-cyan-300 shrink-0" />
      <span className="truncate" title={account.id}>{account.preferences?.personalizedGreeting && account.role !== "guest" ? `Welcome, ${account.displayName}` : account.displayName} · {account.role}</span>
      <button type="button" className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20" onClick={() => setShowManager(true)}>Accounts</button>
      <button type="button" className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20" onClick={() => void signOut()}>Lock / switch</button>
    </div>
    {account.role === "owner" && <p className="fixed z-[110] left-3 top-3 max-w-xs rounded-lg bg-amber-950/90 border border-amber-600/50 px-2 py-1 text-[10px] text-amber-100">
      Protected mode: Live voice, desktop tools, camera, mobile companion and unscoped controls are locked pending per-user integration. Chat and memories remain available.
    </p>}
  </>;

  const locked = status.enabled && status.initialized && !account;
  return <div className="fixed inset-0 z-[100] overflow-y-auto bg-[#070b17] text-slate-100">
    <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_25%_5%,rgba(34,211,238,.13),transparent_48%),radial-gradient(ellipse_at_100%_100%,rgba(168,85,247,.12),transparent_50%)]" />
    <div className="relative mx-auto max-w-6xl min-h-screen p-4 sm:p-8">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 pb-5">
        <div className="flex items-center gap-3"><div className="p-2 rounded-xl bg-cyan-400/10 text-cyan-300"><LockKeyhole className="size-6" /></div>
          <div><p className="uppercase tracking-[.32em] text-xs text-cyan-300">SARA 6.0</p><h1 className="text-xl sm:text-2xl font-semibold">Account & privacy center</h1></div></div>
        {showManager && account ? <button type="button" className="flex items-center gap-2 text-sm text-slate-300 hover:text-white" onClick={() => { setShowManager(false); void refresh(); }}><X className="size-5" /> Close</button> :
          !status.enabled ? <button type="button" className="text-sm text-slate-300 hover:text-white" onClick={() => setShowSetup(false)}>Return to SARA</button> : null}
      </header>
      {notice && <div role="alert" className="my-5 rounded-xl border border-amber-600/50 bg-amber-950/40 p-3 text-sm text-amber-100">{notice}</div>}
      {status.error && <div role="alert" className="mt-8 p-4 rounded-xl bg-red-950/40 border border-red-700/40">{status.error} If account data is damaged, restore a reviewed backup; do not reset or bypass the account store.
        <button type="button" className="auth-outline mt-4 sm:max-w-28" onClick={() => void refresh()}>Retry</button>
      </div>}
      {!status.initialized && !status.error && <main className="mx-auto max-w-xl mt-12 rounded-3xl border border-cyan-400/20 bg-white/[.04] p-5 sm:p-8 shadow-2xl">
        <h2 className="text-xl font-semibold mb-2">Protect this installation</h2>
        <p className="text-sm text-slate-400 leading-relaxed mb-6">This is an explicit opt-in. Existing desktop conversations and memories stay with the original owner and are backed up before activation. Browser-only settings and experimental voice similarity samples are cleared on protected sign-in because they were never account-scoped; save them separately before proceeding if needed. Old profile labels are not automatically verified or enrolled. After activation, unsupported tools and mobile routes will be locked.</p>
        {!status.ownerSecretConfigured && <p className="text-sm text-amber-200 mb-4">Configure a 32+ character SARA_ADMIN_TOKEN privately on the server, then restart or refresh. No owner account can be created without it.</p>}
        <label className="block text-xs text-slate-300 mb-2">Owner display name</label><input className="auth-input" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Name (not proof of identity)" />
        <label className="block text-xs text-slate-300 mt-4 mb-2">Existing local admin secret</label><input className="auth-input" type="password" autoComplete="off" value={ownerSecret} onChange={(e) => setOwnerSecret(e.target.value)} placeholder="Never share this secret with other users" />
        <button className="auth-button mt-6" type="button" disabled={busy || !status.ownerSecretConfigured} onClick={() => void action(async () => {
          if (!window.confirm("Enable multi-user protection? Legacy desktop and mobile automation will be locked until user-scoped authorization is implemented.")) return;
          await enter(await jsonRequest("/api/users/bootstrap", "POST", { displayName, adminSecret: ownerSecret }));
        })}>Enable protected accounts</button>
      </main>}
      {locked && !status.error && <main className="mx-auto max-w-xl mt-12 rounded-3xl border border-cyan-400/20 bg-white/[.04] p-5 sm:p-8 shadow-2xl">
        <h2 className="text-xl font-semibold mb-2">Locked workspace</h2>
        <p className="text-sm text-slate-400 mb-5">Choose a verified sign-in. A name, nearby voice, face photo, or device pairing is not authentication.</p>
        <label className="block text-xs text-slate-300 mb-2">Account ID (from your invitation)</label><input className="auth-input font-mono" value={signInId} onChange={(e) => setSignInId(e.target.value)} placeholder="u-… or default-user" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4"><button className="auth-button" type="button" disabled={busy || !platformAvailable} onClick={() => void signInPasskey()}><KeyRound className="size-4 inline mr-2" /> Sign in with passkey</button>
          <span className="text-xs text-slate-400 self-center">{platformAvailable ? "Browser reports a platform authenticator. An enrolled passkey is still required." : "Platform passkey unavailable here; use your own passphrase."}</span></div>
        <label className="block text-xs text-slate-300 mt-6 mb-2">Personal passphrase (if you set one)</label><input className="auth-input" type="password" autoComplete="current-password" value={signInPassphrase} onChange={(e) => setSignInPassphrase(e.target.value)} placeholder="Fallback when platform passkeys are unavailable" />
        <button className="auth-outline mt-2" type="button" disabled={busy || !signInId.trim() || !signInPassphrase} onClick={() => void action(async () => enter(await jsonRequest("/api/users/auth/passphrase", "POST", { userId: signInId.trim(), passphrase: signInPassphrase })))}>Sign in with my passphrase</button>
        <label className="block text-xs text-slate-300 mt-6 mb-2">One-time invitation or recovery code</label><input className="auth-input font-mono" type="password" autoComplete="off" value={oneTimeCode} onChange={(e) => setOneTimeCode(e.target.value)} placeholder="Only a code delivered to you privately" />
        <div className="grid grid-cols-2 gap-2 mt-2"><button className="auth-button" type="button" disabled={busy} onClick={() => void action(async () => enter(await jsonRequest("/api/users/auth/invitation", "POST", { userId: signInId.trim(), code: oneTimeCode.trim() })))}>Use invitation</button>
          <button className="auth-outline" type="button" disabled={busy} onClick={() => void action(async () => enter(await jsonRequest("/api/users/auth/recovery", "POST", { userId: signInId.trim(), code: oneTimeCode.trim() })))}>Recover account</button></div>
        <div className="mt-8 border-t border-white/10 pt-5"><p className="text-sm font-medium mb-2">Original owner · this computer only</p>
          <input className="auth-input" type="password" autoComplete="off" value={ownerSecret} onChange={(e) => setOwnerSecret(e.target.value)} placeholder="Local admin secret" />
          <button className="auth-outline mt-2" type="button" disabled={busy} onClick={() => void action(async () => enter(await jsonRequest("/api/users/auth/owner", "POST", { adminSecret: ownerSecret })))}>Verify owner secret</button></div>
      </main>}
      {account && showManager && <Management account={account} platformAvailable={platformAvailable}
        onAccountChange={(next) => setAccount(next)} onLock={() => void signOut()} />}
    </div>
  </div>;
}

function Management({ account, platformAvailable, onAccountChange, onLock }: {
  account: Account; platformAvailable: boolean; onAccountChange: (account: Account) => void; onLock: () => void;
}) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [roster, setRoster] = useState<Account[]>([]);
  const [rolePolicies, setRolePolicies] = useState<Record<Role, Capability[]>>({ owner: permissions, admin: [], member: [], restricted: [], guest: [] });
  const [relationships, setRelationships] = useState<{ id: string; from: string; to: string; label: string }[]>([]);
  const [inviteName, setInviteName] = useState(""); const [inviteRole, setInviteRole] = useState<Role>("member");
  const [oneTime, setOneTime] = useState(""); const [issuedFor, setIssuedFor] = useState("");
  const [newName, setNewName] = useState(account.displayName);
  const [preferences, setPreferences] = useState<Preferences>(account.preferences || { language: "en", personalizedGreeting: false, proactiveConversation: false });
  const [relationFrom, setRelationFrom] = useState(""); const [relationTo, setRelationTo] = useState("");
  const [relationPreset, setRelationPreset] = useState(""); const [relationLabel, setRelationLabel] = useState("");
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const [newPassphrase, setNewPassphrase] = useState(""); const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [idleMinutes, setIdleMinutes] = useState(15);
  const [sessions, setSessions] = useState<{ createdAt: number; lastSeenAt: number; method: string; current: boolean }[]>([]);
  const [passkeys, setPasskeys] = useState<{ id: string; createdAt: string; lastUsedAt?: string }[]>([]);
  const [activity, setActivity] = useState<{ at: string; action: string; result: string; subject: string; actor: string }[]>([]);
  const [systemActivity, setSystemActivity] = useState<typeof activity>([]);
  const manager = account.capabilities.includes("manage_users") && (account.role === "owner" || account.role === "admin");
  const securityManager = account.capabilities.includes("manage_security_settings") && (account.role === "owner" || account.role === "admin");
  const canViewSystemActivity = account.capabilities.includes("view_security_events") && (account.role === "owner" || account.role === "admin");
  const fresh = async () => {
    const me = await jsonRequest("/api/users/me", "GET");
    if (me.freshUntil <= Date.now()) throw new Error("Your re-verification window ended. Lock and sign in again before making sensitive changes.");
  };
  const update = async () => {
    if (manager) { const result = await jsonRequest("/api/users", "GET"); setRoster(result.accounts); setRolePolicies(result.roles); }
    else { const result = await jsonRequest("/api/users/roles", "GET"); setRolePolicies(result.roles); }
    const rel = await jsonRequest("/api/users/relationships", "GET"); setRelationships(rel.relationships);
    const { settings } = await jsonRequest("/api/users/settings", "GET"); setIdleMinutes(settings.sessionIdleMinutes);
  };
  useEffect(() => { void update().catch((error) => setNotice(error instanceof Error ? error.message : "Unable to load user management.")); }, [account.id]);
  useEffect(() => {
    if (tab === "security") {
      void jsonRequest("/api/users/me/sessions", "GET")
        .then((result) => setSessions(result.sessions)).catch((error) => setNotice(error.message));
      void jsonRequest("/api/users/me/passkeys", "GET")
        .then((result) => setPasskeys(result.passkeys)).catch((error) => setNotice(error.message));
    }
    if (tab === "activity") void jsonRequest("/api/users/me/activity", "GET")
      .then((result) => setActivity(result.events)).catch((error) => setNotice(error.message));
    if (tab === "systemActivity" && canViewSystemActivity) void fresh()
      .then(() => jsonRequest("/api/users/security/activity", "GET"))
      .then((result) => setSystemActivity(result.events))
      .catch((error) => { setSystemActivity([]); setNotice(error.message); });
  }, [tab, account.id]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await fn(); } catch (error) { setNotice(error instanceof Error ? error.message : "Request denied."); }
    finally { setBusy(false); }
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: "dashboard", label: "Overview" }, ...(manager ? [{ id: "people" as Tab, label: "People" }] : []),
    { id: "roles", label: "Permissions" }, { id: "relationships", label: "Relationships" },
    { id: "profile", label: "My profile" }, { id: "security", label: "Authentication" },
    ...(account.role !== "restricted" && account.role !== "guest" ? [{ id: "activity" as Tab, label: "My activity" }] : []),
    ...(canViewSystemActivity ? [{ id: "systemActivity" as Tab, label: "Security activity" }] : []),
    { id: "data", label: "My data" },
  ];
  return <div className="pt-7 grid grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)] gap-6">
    <nav className="flex md:flex-col gap-2 overflow-x-auto pb-2" aria-label="Account settings">
      {tabs.map((item) => <button key={item.id} type="button" onClick={() => { setTab(item.id); setOneTime(""); setIssuedFor(""); setNotice(""); }} className={`shrink-0 rounded-xl px-4 py-3 text-left text-sm ${tab === item.id ? "bg-cyan-400/15 text-cyan-200 border border-cyan-400/30" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}>{item.label}</button>)}
      <button type="button" className="shrink-0 text-sm px-4 py-3 text-left rounded-xl bg-rose-500/10 text-rose-200" onClick={onLock}>Lock & switch</button>
    </nav>
    <main className="min-w-0 rounded-2xl border border-white/10 bg-white/[.035] p-5 sm:p-7">
      {notice && <p role="alert" className="mb-4 rounded-xl border border-amber-500/40 bg-amber-900/20 p-3 text-sm text-amber-200">{notice}</p>}
      {tab === "dashboard" && <section><h2 className="text-xl font-semibold mb-3">Account overview</h2>
        {account.preferences?.personalizedGreeting && account.role !== "guest" && <p className="text-sm text-cyan-200 mb-3">Welcome, {account.displayName}. Your private workspace is ready.</p>}
        <p className="text-sm text-slate-300 mb-6">You are signed in as <strong>{account.displayName}</strong> ({account.role}). Roles decide app capabilities; relationships are descriptive labels only. No role can read another person’s private memories or conversations.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{["Private conversations", "Approved memories", "People directory"].map((name, index) => <div key={name} className="rounded-xl bg-slate-800/60 p-4"><p className="text-xs text-slate-400 mb-2">{name}</p><p className="text-sm">{account.capabilities.includes(index === 0 ? "chat" : index === 1 ? "memory" : "manage_users") ? "Available to this account" : "Not permitted"}</p></div>)}</div>
        <p className="text-xs text-amber-200 mt-6">Voice identity, face recognition and Windows Hello named-user verification are not implemented. Unscoped agent tools, screen/camera server APIs and the separate mobile server remain locked in protected mode.</p></section>}
      {tab === "people" && manager && <section><h2 className="text-xl font-semibold mb-2">People</h2><p className="text-sm text-slate-400 mb-5">Invite first; the person signs in with a one-time code and must consent to their own passkey enrollment. Do not send invitation codes in public chats. Once accepted, only that person can issue their recovery code; owners cannot use recovery to read someone else’s data.</p>
        <div className="flex flex-col sm:flex-row gap-2 mb-4"><input className="auth-input" placeholder="Display name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
          <select className="auth-input sm:max-w-36" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>{roles.filter((r) => r !== "owner" && (account.role === "owner" || r !== "admin")).map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <button className="auth-button sm:max-w-32" type="button" disabled={busy} onClick={() => void run(async () => { await fresh(); if (!window.confirm(`Invite ${inviteName} as ${inviteRole}?`)) return;
            const result = await jsonRequest("/api/users", "POST", { displayName: inviteName, role: inviteRole });
            setOneTime(result.invitation); setIssuedFor(result.account.id); setInviteName(""); await update(); })}><Plus className="inline size-4 mr-1" /> Invite</button></div>
        {oneTime && <div className="rounded-xl bg-amber-950/40 border border-amber-500/40 p-4 mb-5"><p className="text-sm font-medium text-amber-200">Invitation — displayed once. Share both the account ID and one-time code privately with the intended person, then dismiss the code.</p>
          <p className="mt-2 text-xs">Account ID</p><code className="block break-all text-sm font-mono">{issuedFor}</code>
          <p className="mt-2 text-xs">One-time code</p><code className="block break-all text-sm font-mono">{oneTime}</code><button className="auth-outline mt-3 sm:max-w-24" onClick={() => { setOneTime(""); setIssuedFor(""); }}>Dismiss</button></div>}
        <div className="space-y-2">{roster.map((person) => <div key={person.id} className="rounded-xl border border-white/10 p-3 flex flex-wrap gap-3 items-center justify-between"><div><p className="font-medium text-sm">{person.displayName} {person.disabled ? "· disabled" : ""}</p><p className="font-mono text-[11px] text-slate-400 break-all">{person.id} · {person.role} · {person.hasPasskey ? "passkey enrolled" : "no passkey"}</p>
            <p className="text-xs text-slate-400">{person.activatedAt ? `${person.activeSessions} active session${person.activeSessions === 1 ? "" : "s"}` : "Invitation pending"}{person.lastUsedAt ? ` · Last recorded activity ${new Date(person.lastUsedAt).toLocaleString()}` : ""}</p></div>
          <div className="flex gap-2 flex-wrap">{account.role === "owner" && person.id !== account.id && <><select aria-label={`Role for ${person.displayName}`} className="auth-input w-auto" value={person.role} disabled={busy} onChange={(e) => void run(async () => { await fresh(); if (!window.confirm(`Change ${person.displayName} to ${e.target.value}? Their sessions will be revoked and individual overrides reset.`)) return;
            await jsonRequest(`/api/users/accounts/${person.id}`, "PATCH", { role: e.target.value }); await update(); })}>{roles.filter((r) => r !== "owner").map((r) => <option key={r}>{r}</option>)}</select>
          <button className="auth-outline w-auto" disabled={busy} onClick={() => void run(async () => { await fresh(); if (!window.confirm(`${person.disabled ? "Enable" : "Disable"} ${person.displayName}? Current sessions will be revoked.`)) return;
            await jsonRequest(`/api/users/accounts/${person.id}`, "PATCH", { disabled: !person.disabled }); await update(); })}>{person.disabled ? "Enable" : "Disable"}</button>
          <button className="auth-outline w-auto" disabled={busy || person.activeSessions === 0} onClick={() => void run(async () => {
            await fresh(); if (!window.confirm(`Revoke all sessions for ${person.displayName}? They will need to authenticate again. This does not access their content.`)) return;
            const result = await jsonRequest(`/api/users/accounts/${person.id}/revoke-sessions`, "POST");
            await update(); setNotice(`${result.revoked} session(s) revoked for ${person.displayName}.`);
          })}>Revoke sessions</button>
          {!person.activatedAt && <button className="auth-outline w-auto" disabled={busy} onClick={() => void run(async () => { await fresh(); if (!window.confirm(`Replace the unaccepted invitation for ${person.displayName}? The previous code will stop working.`)) return;
            const result = await jsonRequest(`/api/users/accounts/${person.id}/invitation`, "POST"); setOneTime(result.code); setIssuedFor(person.id); })}>Replace invitation</button>}
          <div className="basis-full flex flex-wrap gap-2 mt-1" aria-label={`Individual permissions for ${person.displayName}`}>{permissions.map((cap) => <label key={cap} className="text-xs text-slate-300 flex items-center gap-1.5"><input type="checkbox" disabled={busy || (person.role === "guest" && cap !== "chat") ||
                (person.role !== "admin" && person.role !== "owner" && administrativePermissions.includes(cap))} checked={person.capabilities.includes(cap)} onChange={(event) => void run(async () => {
            await fresh(); if (!window.confirm(`Change ${cap} permission for ${person.displayName}? Their sessions will be revoked.`)) return;
            const base = rolePolicies[person.role]?.includes(cap);
            const selected = event.target.checked;
            const allow = new Set(person.allow), deny = new Set(person.deny);
            if (base) { if (selected) deny.delete(cap); else deny.add(cap); }
            else { if (selected) allow.add(cap); else allow.delete(cap); }
            await jsonRequest(`/api/users/accounts/${person.id}`, "PATCH", { allow: [...allow], deny: [...deny] }); await update();
          })} /> {cap.replaceAll("_", " ")}</label>)}</div></>}</div></div>)}</div>
      </section>}
      {tab === "roles" && <section><h2 className="text-xl font-semibold mb-2">Roles & capabilities</h2><p className="text-sm text-slate-400 mb-5">Relationships grant no authority. Private user data is never a grantable capability. Tool, camera, voice and mobile permissions are not available until their trusted routes are integrated.</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{roles.map((role) => <div key={role} className="rounded-xl border border-white/10 p-4"><h3 className="font-medium capitalize mb-3">{role}</h3><div className="flex flex-wrap gap-2">{permissions.map((cap) => <label key={cap} className="flex items-center gap-2 text-xs bg-white/5 px-3 py-2 rounded-lg"><input type="checkbox" checked={(rolePolicies[role] || []).includes(cap)} disabled={account.role !== "owner" || role === "owner" || (role === "guest" && cap !== "chat") ||
            (role !== "admin" && administrativePermissions.includes(cap) && !(rolePolicies[role] || []).includes(cap)) || busy} onChange={(e) => void run(async () => { await fresh(); if (!window.confirm(`Update ${role} permission ${cap}? All ${role} sessions will be revoked.`)) return;
            const selected = new Set(rolePolicies[role]); if (e.target.checked) selected.add(cap); else selected.delete(cap);
            await jsonRequest(`/api/users/roles/${role}`, "PATCH", { capabilities: [...selected] }); await update(); })} /> {cap.replaceAll("_", " ")}</label>)}</div></div>)}</div></section>}
      {tab === "relationships" && <section><h2 className="text-xl font-semibold mb-2">Relationships</h2><p className="text-sm text-slate-400 mb-5">Labels describe connections such as teacher or family. They do not authenticate someone or permit access to their data.</p>
        {account.role === "owner" && <div className="flex flex-col sm:flex-row gap-2 mb-4"><select className="auth-input" aria-label="First person" value={relationFrom} onChange={(e) => setRelationFrom(e.target.value)}><option value="">From</option>{roster.map((a) => <option value={a.id} key={a.id}>{a.displayName}</option>)}</select>
          <select className="auth-input" aria-label="Second person" value={relationTo} onChange={(e) => setRelationTo(e.target.value)}><option value="">To</option>{roster.map((a) => <option value={a.id} key={a.id}>{a.displayName}</option>)}</select>
          <select className="auth-input" aria-label="Relationship type" value={relationPreset} onChange={(e) => setRelationPreset(e.target.value)}><option value="">Select relationship</option>{relationshipOptions.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select>
          {relationPreset === "other" && <input className="auth-input" aria-label="Custom relationship label" maxLength={60} placeholder="Your own label" value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} />}
          <button className="auth-button sm:max-w-24" type="button" disabled={busy || !relationFrom || !relationTo || relationFrom === relationTo || !relationPreset || (relationPreset === "other" && !relationLabel.trim())} onClick={() => void run(async () => { await fresh(); if (!window.confirm("Save descriptive relationship? It grants no authority or access.")) return;
            await jsonRequest("/api/users/relationships", "POST", { from: relationFrom, to: relationTo, label: relationPreset === "other" ? relationLabel.trim() : relationPreset }); setRelationLabel(""); setRelationPreset(""); await update(); })}>Add</button></div>}
        <div className="space-y-2">{relationships.map((item) => <div key={item.id} className="rounded-xl bg-white/5 p-3 text-sm break-words flex flex-wrap items-center justify-between gap-2"><span>{roster.find((a) => a.id === item.from)?.displayName || item.from} → {roster.find((a) => a.id === item.to)?.displayName || item.to}: <strong>{item.label}</strong></span>
          {account.role === "owner" && <button type="button" className="text-xs text-rose-300 hover:text-rose-100" disabled={busy} onClick={() => void run(async () => {
            await fresh(); if (!window.confirm(`Remove the ${item.label} label? This cannot change anyone's permissions.`)) return;
            await jsonRequest(`/api/users/relationships/${encodeURIComponent(item.id)}`, "DELETE"); await update();
          })}>Remove label</button>}</div>)}{!relationships.length && <p className="text-sm text-slate-500">No relationship labels for this account.</p>}</div></section>}
      {tab === "profile" && <section className="max-w-lg"><h2 className="text-xl font-semibold mb-2">My profile</h2><p className="text-sm text-slate-400 mb-5">Your stable account ID never changes. A display name is not identity verification.</p><p className="font-mono text-xs break-all text-cyan-200 mb-4">{account.id}</p>
        <label className="block text-xs mb-2">Display name</label><input className="auth-input" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="auth-button mt-3 sm:max-w-40" type="button" disabled={busy || !newName.trim() || account.role === "guest"} onClick={() => void run(async () => { const result = await jsonRequest("/api/users/me", "PATCH", { displayName: newName }); onAccountChange(result.account); setNotice("Display name saved."); })}>Save name</button>
        <div className="mt-8 border-t border-white/10 pt-5 space-y-4"><h3 className="font-medium">My preferences</h3>
          <p className="text-xs text-slate-400">Only your verified account can edit or export these. Relationship labels and observed appearance/voice never set them for you. The language guides text chat but cannot guarantee every model response.</p>
          <label className="block text-xs" htmlFor="preferred-language">Preferred chat language</label>
          <select id="preferred-language" className="auth-input" disabled={account.role === "guest"} value={preferences.language} onChange={(event) => setPreferences({ ...preferences, language: event.target.value })}>
            {languages.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={account.role === "guest"} checked={preferences.personalizedGreeting} onChange={(event) => setPreferences({ ...preferences, personalizedGreeting: event.target.checked })} /> Greet me by my chosen display name in my private workspace (never name or identify me from a camera or voice).</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={account.role === "guest"} checked={preferences.proactiveConversation} onChange={(event) => setPreferences({ ...preferences, proactiveConversation: event.target.checked })} /> I opt in to proactive conversation if an account-scoped service becomes available.</label>
          <p className="text-xs text-amber-200">Protected-mode proactive voice/background actions remain disabled even when this is selected; they require a separate reviewed identity and consent implementation.</p>
          <button className="auth-outline sm:max-w-44" type="button" disabled={busy || account.role === "guest"} onClick={() => void run(async () => {
            const result = await jsonRequest("/api/users/me/preferences", "PATCH", { preferences });
            onAccountChange(result.account); setPreferences(result.account.preferences); setNotice("Your personal preferences were saved.");
          })}>Save preferences</button>
        </div></section>}
      {tab === "security" && <section className="max-w-xl"><h2 className="text-xl font-semibold mb-2">Authentication center</h2><p className="text-sm text-slate-400 mb-5">SARA requests a browser platform authenticator with user verification and checks its WebAuthn response. Without trusted device attestation, the server cannot prove authenticator hardware or which person used it. SARA stores a public key and enrollment consent record, never a face image, fingerprint, or voiceprint.</p>
        <p className="text-sm mb-3">{account.hasPasskey ? "A passkey is enrolled." : "No passkey is enrolled."} {platformAvailable ? "This browser reports a user-verifying platform authenticator." : "No usable platform authenticator detected here. Enrollment is unavailable."}</p>
        <label className="flex items-start gap-3 text-sm text-slate-300 mb-3"><input className="mt-1" type="checkbox" disabled={account.role === "guest"} checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I am the signed-in account holder and explicitly consent to enroll my own platform passkey on this device.</label>
        <button className="auth-button sm:max-w-60" disabled={busy || !consent || !platformAvailable || account.role === "guest"} type="button" onClick={() => void run(async () => {
          const begin = await jsonRequest("/api/users/passkeys/enroll/options", "POST", { consent: true });
          const response = await startRegistration({ optionsJSON: begin.options });
          const result = await jsonRequest("/api/users/passkeys/enroll/verify", "POST", { ceremonyId: begin.ceremonyId, response });
          onAccountChange(result.account); setConsent(false);
          setPasskeys((await jsonRequest("/api/users/me/passkeys", "GET")).passkeys);
          setNotice("Passkey registered to this account. Its verification is not proof of a named person or biometric type.");
        })}>Enroll my passkey</button>
        {passkeys.length > 0 && <div className="mt-6 rounded-xl bg-white/5 p-4"><h3 className="text-sm font-medium mb-2">My enrolled passkeys</h3>
          <p className="text-xs text-slate-400 mb-3">Only you can revoke these after fresh passkey or local-owner verification. This ends every current session for your account; you must sign in again. Removing the server registration does not delete the authenticator from your device.</p>
          {passkeys.map((key) => <div key={key.id} className="flex flex-wrap justify-between gap-2 items-center border-t border-white/10 py-2 text-xs"><span>Added {new Date(key.createdAt).toLocaleString()}{key.lastUsedAt ? ` · used ${new Date(key.lastUsedAt).toLocaleString()}` : ""}</span>
            <button type="button" className="text-rose-300 hover:text-rose-100" disabled={busy} onClick={() => void run(async () => {
              if (!window.confirm("Revoke this passkey and every session on your account? Make sure you have another sign-in method or your own recovery code.")) return;
              const result = await jsonRequest("/api/users/me/passkeys/revoke", "POST", { credentialId: key.id });
              if (!result.locked) throw new Error("Passkey could not be revoked safely.");
              onLock();
            })}>Revoke passkey</button></div>)}
        </div>}
        <div className="mt-6 rounded-xl bg-white/5 p-4"><h3 className="text-sm font-medium mb-2">My fallback passphrase</h3>
          <p className="text-xs text-slate-400 mb-3">Use a unique passphrase of at least 16 characters when this platform cannot support WebAuthn. The server stores only a salted scrypt verifier. Changing it revokes your other sessions.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><input aria-label="New passphrase" className="auth-input" type="password" autoComplete="new-password" value={newPassphrase} onChange={(e) => setNewPassphrase(e.target.value)} placeholder="New passphrase · 16+ chars" />
            <input aria-label="Confirm new passphrase" className="auth-input" type="password" autoComplete="new-password" value={confirmPassphrase} onChange={(e) => setConfirmPassphrase(e.target.value)} placeholder="Confirm passphrase" /></div>
          <button className="auth-outline mt-3 sm:max-w-60" disabled={busy || account.role === "guest" || newPassphrase.length < 16 || newPassphrase !== confirmPassphrase} onClick={() => void run(async () => {
            const result = await jsonRequest("/api/users/me/passphrase", "POST", { passphrase: newPassphrase });
            if (!result.ok) throw new Error("Passphrase was not saved.");
            setNewPassphrase(""); setConfirmPassphrase(""); onAccountChange({ ...account, hasPassphrase: true }); setNotice("Personal passphrase saved. Other sessions have been revoked.");
          })}>{account.hasPassphrase ? "Change my passphrase" : "Set my passphrase"}</button>
        </div>
        <div className="mt-6 rounded-xl bg-white/5 p-4"><h3 className="text-sm font-medium mb-2">My one-time recovery code</h3>
          <p className="text-xs text-slate-400 mb-3">Create it yourself after signing in. Store it offline; replacing a code invalidates the old one. Nobody else can issue a code for your active account.</p>
          <button className="auth-outline sm:max-w-60" disabled={busy || account.role === "guest"} onClick={() => void run(async () => {
            if (!window.confirm("Generate a new private recovery code for your own account? The prior code will stop working.")) return;
            const result = await jsonRequest("/api/users/me/recovery-code", "POST"); setOneTime(result.code);
          })}>Generate my recovery code</button>
          {oneTime && <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-950/40 p-3"><p className="text-xs text-amber-200">Displayed once. Keep it privately with account ID {account.id}, then dismiss before leaving.</p><code className="block break-all text-xs font-mono mt-2">{oneTime}</code><button className="auth-outline sm:max-w-24 mt-3" onClick={() => setOneTime("")}>Dismiss</button></div>}
        </div>
        <div className="mt-6 rounded-xl bg-white/5 p-4"><h3 className="text-sm font-medium mb-2">Inactivity lock</h3>
          <p className="text-xs text-slate-400 mb-3">Sessions lock after this many minutes without an authenticated action. Checking session status and switching browser tabs do not keep a session alive. Absolute session expiry still applies.</p>
          <div className="flex flex-wrap gap-2 items-center"><select aria-label="Idle lock minutes" value={idleMinutes} className="auth-input max-w-40" disabled={!securityManager} onChange={(e) => setIdleMinutes(Number(e.target.value))}>{[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select>
            {securityManager && <button type="button" className="auth-outline sm:max-w-36" disabled={busy} onClick={() => void run(async () => {
              if (!window.confirm(`Set the inactivity lock to ${idleMinutes} minutes for everyone?`)) return;
              await fresh(); const result = await jsonRequest("/api/users/settings", "PATCH", { sessionIdleMinutes: idleMinutes });
              setIdleMinutes(result.settings.sessionIdleMinutes); setNotice("Inactivity lock saved.");
            })}>Save idle lock</button>}</div>
        </div>
        <div className="mt-6 rounded-xl bg-white/5 p-4"><h3 className="text-sm font-medium mb-2">My active sessions</h3>
          <p className="text-xs text-slate-400 mb-3">Only your sessions are listed. No other account can unlock or revoke them with a relationship label.</p>
          {sessions.map((item, index) => <p key={`${item.createdAt}-${index}`} className="text-xs text-slate-300 mb-2">{item.current ? "This device" : "Other session"} · {item.method} · last action {new Date(item.lastSeenAt).toLocaleString()}</p>)}
          <button className="auth-outline mt-3 sm:max-w-56" type="button" disabled={busy || !sessions.some((item) => !item.current)} onClick={() => void run(async () => {
            if (!window.confirm("Revoke every other session signed in to your account?")) return;
            const result = await jsonRequest("/api/users/me/revoke-other-sessions", "POST");
            if (!result.ok) throw new Error("Other sessions could not be revoked.");
            setSessions((current) => current.filter((item) => item.current)); setNotice("Other sessions revoked.");
          })}>Revoke other sessions</button>
        </div>
        <div className="mt-8 border-t border-white/10 pt-4 text-xs text-slate-400 space-y-2"><p>Owner secret: only on the local computer. Invitations and recovery codes are single-use. After recovery, prior passkeys, passphrase and sessions are revoked.</p>
          <p>To make sensitive permission changes after two minutes, lock and re-authenticate. Sign-out revokes this session. Device biometric prompts do not identify anyone without their registered passkey.</p></div></section>}
      {tab === "activity" && <section><h2 className="text-xl font-semibold mb-2">My account activity</h2>
        <p className="text-sm text-slate-400 mb-5">Recent authentication, recovery and account changes involving you. Only metadata is logged, not your messages or biometric data. This local log is not tamper-evident.</p>
        <div className="space-y-2">{activity.map((event, index) => <div key={`${event.at}-${index}`} className="flex flex-wrap justify-between gap-2 rounded-xl bg-white/5 p-3 text-xs"><span className="break-words">{event.action.replaceAll("_", " ")} · {event.result}</span><time className="text-slate-400" dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></div>)}
          {!activity.length && <p className="text-sm text-slate-500">No recent account activity found.</p>}</div>
      </section>}
      {tab === "systemActivity" && canViewSystemActivity && <section><h2 className="text-xl font-semibold mb-2">Installation security activity</h2>
        <p className="text-sm text-slate-400 mb-5">Only a recently passkey-verified, explicitly permitted admin or the locally verified owner can view these recent account/security events. Contains account IDs and action metadata, not messages, secrets or biometrics. This local log is not tamper-evident.</p>
        <div className="space-y-2">{systemActivity.map((event, index) => <div key={`${event.at}-${index}`} className="rounded-xl bg-white/5 p-3 text-xs flex flex-wrap justify-between gap-2"><span className="break-all">{event.action.replaceAll("_", " ")} · {event.result} · {event.actor} → {event.subject}</span><time className="text-slate-400" dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></div>)}
          {!systemActivity.length && <p className="text-sm text-slate-500">No recent security events available. If verification expired, lock and sign in again.</p>}</div></section>}
      {tab === "data" && <section className="max-w-xl"><h2 className="text-xl font-semibold mb-2">My private data</h2>
        <p className="text-sm text-slate-400 mb-5">Download your own account profile, accessible memories, conversations and relationship labels as JSON. Only data you currently have permission to access is included. The export never contains sign-in secrets, passkey credentials or anyone else’s content.</p>
        <button className="auth-button sm:max-w-52" type="button" disabled={busy || account.role === "guest"} onClick={() => void run(async () => {
          await fresh(); const snapshot = await jsonRequest("/api/users/me/export", "GET");
          const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a"); link.href = url;
          link.download = `sara-${account.id}-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(link); link.click(); link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          setNotice("Private data export created. Keep the downloaded file secure.");
        })}>Download my data</button>
        <p className="text-xs text-amber-200 mt-6">You can correct/delete individual saved memories and delete your own conversations from the private workspace. Account-wide deletion, secure erasure of backups and cross-device deletion are not yet available. Guests have no persisted conversation or memory export.</p>
      </section>}
    </main>
  </div>;
}

function SecureChat({ account, onSessionLost }: { account: Account; onSessionLost: () => void }) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<{ id: string; title?: string; updatedAt?: string; messages?: { role: string; text?: string; content?: string }[] }[]>([]);
  const [text, setText] = useState(""); const [sending, setSending] = useState(false);
  const [error, setError] = useState(""); const [view, setView] = useState<"chat" | "memory">("chat");
  const [memories, setMemories] = useState<{ id: string; category: string; text: string }[]>([]);
  const [memoryText, setMemoryText] = useState(""); const [memoryCategory, setMemoryCategory] = useState("preference");
  useEffect(() => {
    if (account.role === "guest" || !account.capabilities.includes("chat")) return;
    let active = true;
    void jsonRequest("/api/conversations", "GET").then((list) => {
      if (!active || !Array.isArray(list)) return;
      setConversationList(list);
      const latest = list[0];
      if (latest?.id) { setConversationId(latest.id); setMessages((latest.messages || []).filter((m: any) => m.role === "user" || m.role === "assistant").map((m: any) => ({ role: m.role, text: String(m.text || m.content || "") }))); }
    }).catch(() => {});
    return () => { active = false; };
  }, [account.id, account.role]);
  const loadMemory = () => void jsonRequest("/api/memories", "GET").then((data) => setMemories(Array.isArray(data) ? data : [])).catch((e) => setError(e.message));
  useEffect(() => { if (view === "memory" && account.capabilities.includes("memory")) loadMemory(); }, [view, account.id]);
  const send = async () => {
    const request = text.trim(); if (!request || sending) return;
    setSending(true); setError(""); setText("");
    const history = messages.slice(-8); setMessages((current) => [...current, { role: "user", text: request }]);
    try {
      const result = await jsonRequest("/api/chat", "POST", { text: request, history, source: "desktop", conversationId: account.role === "guest" ? null : conversationId });
      if (result.conversationId) {
        setConversationId(result.conversationId);
        void jsonRequest("/api/conversations", "GET").then((list) => { if (Array.isArray(list)) setConversationList(list); }).catch(() => {});
      }
      setMessages((current) => [...current, { role: "assistant", text: String(result.text || "") }]);
    } catch (e) { setError(e instanceof Error ? e.message : "Chat failed."); setMessages((current) => current.slice(0, -1));
      if ((e instanceof Error ? e.message : "").includes("Sign in")) onSessionLost(); }
    finally { setSending(false); }
  };
  return <div className="min-h-screen bg-[#070b17] text-slate-100 flex flex-col"><header className="border-b border-white/10 py-4 px-4 sm:px-8 flex items-center gap-3 pr-48"><div className="rounded-xl bg-cyan-400/10 p-2"><CircleUserRound className="size-5 text-cyan-300" /></div><div><h1 className="font-semibold">SARA · private workspace</h1><p className="text-xs text-slate-400">{account.role === "guest" ? "Temporary guest context · no disk history" : `${account.displayName} · personal conversation`}</p></div></header>
    <div className="flex-1 max-w-4xl w-full mx-auto flex flex-col min-h-0 p-4 sm:p-8 pt-12 sm:pt-8">
      <div className="flex gap-3 border-b border-white/10 pb-3 mb-4"><button className={`text-sm px-3 py-2 rounded-lg ${view === "chat" ? "bg-cyan-400/15 text-cyan-200" : "text-slate-400"}`} onClick={() => setView("chat")}><MessageCircle className="size-4 inline mr-1" /> Chat</button>
        {account.capabilities.includes("memory") && <button className={`text-sm px-3 py-2 rounded-lg ${view === "memory" ? "bg-cyan-400/15 text-cyan-200" : "text-slate-400"}`} onClick={() => setView("memory")}>My memories</button>}
        {view === "chat" && account.capabilities.includes("chat") && <div className="ml-auto flex gap-2 items-center min-w-0">
          {account.role !== "guest" && <select aria-label="My conversations" className="auth-input text-xs max-w-[160px] sm:max-w-56" disabled={sending} value={conversationId || ""} onChange={(event) => {
            const id = event.target.value;
            const selected = conversationList.find((item) => item.id === id);
            setConversationId(id || null);
            setMessages((selected?.messages || []).filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => ({ role: message.role as "user" | "assistant", text: String(message.text || message.content || "") })));
          }}><option value="">New conversation</option>{conversationList.map((item) => <option key={item.id} value={item.id}>{item.title && item.title !== "Conversation" ? item.title.slice(0, 32) : new Date(item.updatedAt || Date.now()).toLocaleString()}</option>)}</select>}
          <button className="text-xs text-slate-400 hover:text-white whitespace-nowrap" disabled={sending} onClick={() => { setConversationId(null); setMessages([]); }}>New</button>
          {account.role !== "guest" && conversationId && <button className="text-xs text-rose-300 hover:text-rose-100" disabled={sending} onClick={() => {
            if (!window.confirm("Delete this conversation and its saved messages?")) return;
            void jsonRequest(`/api/conversations/${encodeURIComponent(conversationId)}`, "DELETE")
              .then(() => { setConversationList((items) => items.filter((item) => item.id !== conversationId)); setConversationId(null); setMessages([]); })
              .catch((e) => setError(e.message));
          }}>Delete</button>}
        </div>}</div>
      {error && <p role="alert" className="rounded-lg bg-amber-950/40 p-3 text-sm text-amber-200 mb-3">{error}</p>}
      {view === "chat" && !account.capabilities.includes("chat") ? <p className="text-sm text-amber-200 p-4 rounded-xl border border-amber-500/30">This account does not have chat permission. Ask the owner to review an explicit permission grant.</p> : view === "chat" ? <><div aria-live="polite" className="flex-1 min-h-[35vh] max-h-[60vh] overflow-y-auto space-y-3 pb-5">{messages.length === 0 && <p className="text-center text-sm text-slate-500 mt-14">{account.preferences?.personalizedGreeting && account.role !== "guest" ? `Welcome, ${account.displayName}. ` : ""}Your conversation starts here. SARA will not use another person’s memories or history.</p>}
        {messages.map((message, index) => <div key={index} className={`rounded-2xl p-3 text-sm whitespace-pre-wrap max-w-[85%] ${message.role === "user" ? "ml-auto bg-cyan-900/30 border border-cyan-400/20" : "mr-auto bg-white/5 border border-white/10"}`}>{message.text}</div>)}{sending && <p className="text-xs text-cyan-200 animate-pulse">SARA is responding…</p>}</div>
        <form className="flex gap-2 mt-auto" onSubmit={(e) => { e.preventDefault(); void send(); }}><input aria-label="Message SARA" className="auth-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder="Ask SARA…" /><button className="auth-button max-w-24" disabled={sending || !text.trim()}>Send</button></form></> :
        <div className="space-y-4"><p className="text-sm text-slate-400">Only approved facts you choose to save are retrieved for your own chat. Delete or correct them anytime.</p>
          <div className="flex flex-wrap gap-2"><select className="auth-input sm:max-w-40" value={memoryCategory} onChange={(e) => setMemoryCategory(e.target.value)}>{["identity", "preference", "goal", "project", "relationship", "emotional", "behavior", "decision", "question"].map((c) => <option key={c}>{c}</option>)}</select><input className="auth-input sm:flex-1" maxLength={1000} value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="A fact I want SARA to remember" /><button className="auth-button sm:max-w-24" onClick={() => void jsonRequest("/api/memories", "POST", { category: memoryCategory, text: memoryText }).then(() => { setMemoryText(""); loadMemory(); }).catch((e) => setError(e.message))}>Save</button></div>
          {memories.map((item) => <div key={item.id} className="rounded-xl border border-white/10 p-4 flex items-start justify-between gap-2"><div><p className="text-xs text-cyan-300 capitalize">{item.category}</p><p className="text-sm mt-1 break-words">{item.text}</p></div><div className="flex flex-col gap-2 text-xs"><button className="text-cyan-200" aria-label={`Correct memory ${item.text.slice(0, 20)}`} onClick={() => {
            const corrected = window.prompt("Correct this saved memory", item.text);
            if (corrected?.trim() && corrected.trim() !== item.text) void jsonRequest(`/api/memories/${encodeURIComponent(item.id)}`, "PATCH", { category: item.category, text: corrected.trim() }).then(loadMemory).catch((e) => setError(e.message));
          }}>Correct</button><button className="text-rose-300" aria-label={`Delete memory ${item.text.slice(0, 20)}`} onClick={() => { if (window.confirm("Delete this saved memory?")) void jsonRequest(`/api/memories/${encodeURIComponent(item.id)}`, "DELETE").then(loadMemory).catch((e) => setError(e.message)); }}>Delete</button></div></div>)}
        </div>}
    </div>
  </div>;
}
