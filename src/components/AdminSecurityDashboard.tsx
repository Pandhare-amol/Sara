import React, { useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Key,
  Terminal,
  Activity,
  FileText,
  RefreshCw,
  Power,
  X,
  Send,
  Lock,
  Clock,
  Database,
  Layers,
  Filter,
  Check
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = "overview" | "integrity" | "audit" | "notifications" | "system";

function loadSessionAdminToken(): string {
  try {
    const sessionToken = sessionStorage.getItem("sara.adminToken") || "";
    if (sessionToken) return sessionToken;
    const legacyToken = localStorage.getItem("sara.adminToken") || "";
    if (legacyToken) {
      sessionStorage.setItem("sara.adminToken", legacyToken);
      localStorage.removeItem("sara.adminToken");
    }
    return legacyToken;
  } catch {
    return "";
  }
}

export function AdminSecurityDashboard({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [timeFilter, setTimeFilter] = useState<"today" | "7d" | "30d" | "all">("all");
  const [adminToken, setAdminToken] = useState<string>(() => loadSessionAdminToken());
  const [passkeySession, setPasskeySession] = useState<string | null>(() => {
    try { return sessionStorage.getItem("sara.adminPasskeySession"); } catch { return null; }
  });
  const [passkeyStatus, setPasskeyStatus] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);

  const buildAdminHeaders = (base: Record<string, string> = {}): Record<string, string> => {
    const headers = { ...base };
    if (adminToken) headers["x-admin-token"] = adminToken;
    if (passkeySession) headers["x-sara-admin-session"] = passkeySession;
    return headers;
  };

  // SMTP test state
  const [testEmailResult, setTestEmailResult] = useState<string | null>(null);
  const [testWebhookResult, setTestWebhookResult] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    setAuthError(null);
    try {
      const headers = buildAdminHeaders();
      const res = await fetch("/api/admin/stats", { headers });
      if (res.status === 401) {
        setAuthError("Admin authorization token required or invalid.");
        setStats(null);
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setStats(data);
      }
    } catch (e: any) {
      console.error("Failed to load admin stats:", e);
    } finally {
      setLoading(false);
    }
  };

  const fetchAuditEvents = async () => {
    try {
      const headers = buildAdminHeaders();
      const res = await fetch("/api/admin/audit/recent", { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.events)) {
          setAuditEvents(data.events);
        }
      }
    } catch (e) {
      console.error("Failed to fetch audit events:", e);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void fetchStats();
    void fetchAuditEvents();
  }, [isOpen, adminToken, passkeySession]);

  const handleSaveToken = (val: string) => {
    setAdminToken(val);
    try {
      if (val) sessionStorage.setItem("sara.adminToken", val);
      else sessionStorage.removeItem("sara.adminToken");
      window.dispatchEvent(new Event("sara.adminAuthChanged"));
    } catch { /* session storage may be disabled */ }
  };

  const handleEnrollPasskey = async () => {
    if (!adminToken && !passkeySession) {
      setPasskeyStatus("Verify with the existing admin token or an enrolled passkey before adding another device.");
      return;
    }
    setPasskeyStatus("Starting device passkey enrollment…");
    try {
      const optionsResponse = await fetch("/api/admin/passkeys/register/options", {
        method: "POST",
        headers: buildAdminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ userName: "SARA local admin", displayName: "SARA local admin" }),
      });
      const optionsPayload = await optionsResponse.json();
      if (!optionsResponse.ok || !optionsPayload.ok) throw new Error(optionsPayload.error || "Could not start passkey enrollment.");
      const credential = await startRegistration({ optionsJSON: optionsPayload.options });
      const verifyResponse = await fetch("/api/admin/passkeys/register/verify", {
        method: "POST",
        headers: buildAdminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ceremonyId: optionsPayload.ceremonyId, response: credential, name: "This device" }),
      });
      const verifyPayload = await verifyResponse.json();
      if (!verifyResponse.ok || !verifyPayload.ok) throw new Error(verifyPayload.error || "Passkey verification failed.");
      setPasskeyStatus("Passkey registered. This device can now verify SARA admin access.");
    } catch (error: any) {
      setPasskeyStatus(error?.message || "Passkey enrollment failed.");
    }
  };

  const handlePasskeySignIn = async () => {
    setPasskeyStatus("Waiting for device verification…");
    try {
      const optionsResponse = await fetch("/api/admin/passkeys/auth/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const optionsPayload = await optionsResponse.json();
      if (!optionsResponse.ok || !optionsPayload.ok) throw new Error(optionsPayload.error || "Could not start passkey sign-in.");
      const assertion = await startAuthentication({ optionsJSON: optionsPayload.options });
      const verifyResponse = await fetch("/api/admin/passkeys/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ceremonyId: optionsPayload.ceremonyId, response: assertion }),
      });
      const verifyPayload = await verifyResponse.json();
      if (!verifyResponse.ok || !verifyPayload.ok || typeof verifyPayload.sessionToken !== "string") throw new Error(verifyPayload.error || "Passkey verification failed.");
      setPasskeySession(verifyPayload.sessionToken);
      try {
        sessionStorage.setItem("sara.adminPasskeySession", verifyPayload.sessionToken);
        window.dispatchEvent(new Event("sara.adminAuthChanged"));
      } catch { /* session storage may be unavailable */ }
      setPasskeyStatus(`Admin verified on this device until ${new Date(verifyPayload.expiresAt).toLocaleTimeString()}.`);
    } catch (error: any) {
      setPasskeySession(null);
      try {
        sessionStorage.removeItem("sara.adminPasskeySession");
        window.dispatchEvent(new Event("sara.adminAuthChanged"));
      } catch { /* session storage may be unavailable */ }
      setPasskeyStatus(error?.message || "Passkey sign-in failed.");
    }
  };

  const handlePasskeySignOut = async () => {
    const token = passkeySession;
    if (token) {
      try { await fetch("/api/admin/passkeys/logout", { method: "POST", headers: { "x-sara-admin-session": token } }); } catch {}
    }
    setPasskeySession(null);
    try {
      sessionStorage.removeItem("sara.adminPasskeySession");
      window.dispatchEvent(new Event("sara.adminAuthChanged"));
    } catch { /* session storage may be unavailable */ }
    setPasskeyStatus("Passkey admin session ended.");
  };


  const handleTestSmtp = async () => {
    setTestEmailResult("Sending test email...");
    try {
      const headers = buildAdminHeaders({ "Content-Type": "application/json" });
      const res = await fetch("/api/admin/notifications/smtp/test", { method: "POST", headers });
      const data = await res.json();
      if (data.ok) {
        setTestEmailResult(data.email?.ok ? "Test email sent successfully!" : `Failed: ${data.email?.reason || "Check settings"}`);
      } else {
        setTestEmailResult(`Error: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      setTestEmailResult(`Exception: ${e.message}`);
    }
  };

  const handleTestWebhook = async () => {
    setTestWebhookResult("Sending test webhook...");
    try {
      const headers = buildAdminHeaders({ "Content-Type": "application/json" });
      const res = await fetch("/api/admin/notifications/test", { method: "POST", headers });
      const data = await res.json();
      if (data.ok) {
        setTestWebhookResult("Test webhook triggered successfully!");
      } else {
        setTestWebhookResult(`Error: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      setTestWebhookResult(`Exception: ${e.message}`);
    }
  };

  const handleShutdownSara = async () => {
    if (!window.confirm("Are you sure you want to stop the SARA background service?")) return;
    try {
      const response = await fetch("/api/system/shutdown", {
        method: "POST",
        headers: buildAdminHeaders(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Admin authorization failed.");
      alert("SARA background service is shutting down.");
      onClose();
    } catch (e) {
      alert("Shutdown call failed.");
    }
  };

  const filteredEvents = auditEvents.filter((ev) => {
    if (timeFilter === "all") return true;
    const evTime = new Date(ev.timestamp).getTime();
    const now = Date.now();
    if (timeFilter === "today") return now - evTime < 86400000;
    if (timeFilter === "7d") return now - evTime < 7 * 86400000;
    if (timeFilter === "30d") return now - evTime < 30 * 86400000;
    return true;
  });

  const integrityEnabled = stats?.securityStatus?.enabled === true;
  const isTrusted = integrityEnabled && stats?.securityStatus?.status === "TRUSTED";
  const trustBadgeClass = !integrityEnabled
    ? "border-slate-500/30 bg-slate-500/10 text-slate-300"
    : isTrusted
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : "border-rose-500/30 bg-rose-500/10 text-rose-300";

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/70 z-50 backdrop-blur-md"
          />

          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 right-0 w-full max-w-3xl bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_60px_rgba(0,0,0,0.9)] text-white"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between bg-slate-950/80">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${trustBadgeClass}`}>
                  {isTrusted ? <ShieldCheck size={24} /> : <ShieldAlert size={24} className={integrityEnabled ? "animate-pulse" : ""} />}
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    SARA Owner &amp; Security Panel
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border uppercase tracking-wider ${trustBadgeClass}`}>
                      {!integrityEnabled ? "INTEGRITY DISABLED" : isTrusted ? "TRUSTED" : "WARNING"}
                    </span>
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    Ownership, Provenance &amp; Audit Events
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={fetchStats} className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 transition" title="Refresh Stats">
                  <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                </button>
                <button onClick={onClose} className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition">
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Admin token / platform passkey controls */}
            <div className="px-6 py-2 border-b border-white/5 bg-slate-900/60 flex flex-wrap items-center gap-2">
              <Key size={14} className="text-amber-400 shrink-0" />
              <input
                type="password"
                value={adminToken}
                onChange={(e) => handleSaveToken(e.target.value)}
                placeholder="Admin token (needed to enroll first passkey)"
                className="min-w-[180px] flex-1 bg-transparent text-xs font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none"
                autoComplete="current-password"
              />
              <button type="button" onClick={() => void handlePasskeySignIn()} className="px-3 py-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-200 text-[10px] font-mono hover:bg-cyan-400/20">
                Verify with device
              </button>
              <button type="button" onClick={() => void handleEnrollPasskey()} className="px-3 py-1.5 rounded-lg border border-violet-400/30 bg-violet-400/10 text-violet-200 text-[10px] font-mono hover:bg-violet-400/20">
                Enroll this device
              </button>
              {passkeySession && <button type="button" onClick={() => void handlePasskeySignOut()} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-[10px] font-mono hover:bg-white/10">Sign out</button>}
              {passkeyStatus && <div className="basis-full text-[9px] font-mono text-slate-300">{passkeyStatus}</div>}
            </div>

            {authError && (
              <div className="px-6 py-3 border-b border-rose-500/20 bg-rose-950/40 text-rose-300 text-xs font-mono">
                {authError}
              </div>
            )}

            {/* Tabs */}
            <div className="px-6 py-3 border-b border-white/5 flex items-center gap-2 overflow-x-auto bg-white/5">
              {[
                { id: "overview", label: "OVERVIEW", icon: Activity },
                { id: "integrity", label: "PROVENANCE & INTEGRITY", icon: ShieldCheck },
                { id: "audit", label: "AUDIT LOGS", icon: FileText },
                { id: "notifications", label: "ALERTS & WEBHOOKS", icon: Send },
                { id: "system", label: "SYSTEM & SHUTDOWN", icon: Power },
              ].map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id as TabType)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active ? "border-cyan-400 bg-cyan-400/10 text-cyan-300" : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* TAB 1: OVERVIEW */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  {/* Build Identity Card */}
                  <div className="p-5 rounded-2xl border border-white/10 bg-white/5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-mono uppercase tracking-widest text-cyan-300 font-bold flex items-center gap-2">
                        <Layers size={14} /> SARA Build Identity
                      </h4>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/10 text-slate-300">
                        {stats?.build?.application || "SARA"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs font-mono">
                      <div className="p-2.5 rounded-xl bg-slate-900/60 border border-white/5">
                        <span className="text-[9px] text-slate-500 block uppercase">Version</span>
                        <span className="text-white font-bold">{stats?.build?.version || "1.0.0"}</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900/60 border border-white/5">
                        <span className="text-[9px] text-slate-500 block uppercase">Release ID</span>
                        <span className="text-slate-200 truncate block">{stats?.build?.release_id || "v1.0.0-prod"}</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900/60 border border-white/5">
                        <span className="text-[9px] text-slate-500 block uppercase">Git Commit</span>
                        <span className="text-cyan-300">{stats?.build?.source_revision || "main"}</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900/60 border border-white/5">
                        <span className="text-[9px] text-slate-500 block uppercase">Installation ID</span>
                        <span className="text-slate-300 text-[10px] truncate block">{stats?.build?.installation_id || "sara-install"}</span>
                      </div>
                    </div>
                  </div>

                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-400">Total Tasks</span>
                      <div className="text-2xl font-bold font-mono text-white mt-1">{stats?.tasks?.total ?? 0}</div>
                      <span className="text-[10px] font-mono text-emerald-400">{stats?.tasks?.successRate ?? 100}% Success Rate</span>
                    </div>

                    <div className="p-4 rounded-2xl border border-indigo-500/20 bg-indigo-500/5">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-indigo-400">Active Sessions</span>
                      <div className="text-2xl font-bold font-mono text-white mt-1">{stats?.sessions?.active ?? 0}</div>
                      <span className="text-[10px] font-mono text-slate-400">{stats?.sessions?.total ?? 0} total sessions</span>
                    </div>

                    <div className="p-4 rounded-2xl border border-violet-500/20 bg-violet-500/5">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-violet-400">Audit Events</span>
                      <div className="text-2xl font-bold font-mono text-white mt-1">{stats?.auditEventsCount ?? 0}</div>
                      <span className="text-[10px] font-mono text-violet-300">Tamper-evident chain</span>
                    </div>

                    <div className="p-4 rounded-2xl border border-rose-500/20 bg-rose-500/5">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-rose-400">Security Alerts</span>
                      <div className="text-2xl font-bold font-mono text-white mt-1">{stats?.securityEventsCount ?? 0}</div>
                      <span className="text-[10px] font-mono text-slate-400">High / Critical events</span>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: PROVENANCE & INTEGRITY */}
              {activeTab === "integrity" && (
                <div className="space-y-5">
                  <div>
                    <h4 className="text-xs font-mono uppercase tracking-widest text-cyan-300 font-bold">Integrity Monitor</h4>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Signed-baseline verification is disabled in this backend.</p>
                  </div>
                  <div className="p-5 rounded-2xl border border-dashed border-amber-500/30 bg-amber-500/5 text-xs font-mono text-amber-100">
                    No trusted integrity status is being asserted. Verification and baseline approval are unavailable until this feature is implemented and validated.
                  </div>
                </div>
              )}

              {/* TAB 3: AUDIT LOGS */}
              {activeTab === "audit" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-mono uppercase tracking-widest text-cyan-300 font-bold flex items-center gap-2">
                      <Filter size={12} /> Audit Log Chain ({filteredEvents.length})
                    </h4>
                    <div className="flex items-center gap-1">
                      {(["all", "today", "7d", "30d"] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setTimeFilter(f)}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-mono uppercase transition ${timeFilter === f ? "bg-cyan-500/20 border border-cyan-400/40 text-cyan-300" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {filteredEvents.length === 0 ? (
                      <div className="p-6 rounded-2xl border border-dashed border-white/10 bg-white/5 text-center text-xs font-mono text-slate-400">
                        No audit events match the selected time range filter.
                      </div>
                    ) : (
                      filteredEvents.map((ev, i) => (
                        <div key={ev.event_id || i} className="p-3 rounded-xl border border-white/5 bg-slate-950/80 space-y-1.5 text-xs font-mono">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${ev.severity === "HIGH" || ev.severity === "CRITICAL" ? "bg-rose-400 animate-pulse" : ev.severity === "WARNING" ? "bg-amber-400" : "bg-emerald-400"}`} />
                              <span className="font-bold text-white">{ev.event_type}</span>
                            </div>
                            <span className="text-[10px] text-slate-500">{new Date(ev.timestamp).toLocaleString()}</span>
                          </div>
                          {ev.event_hash && (
                            <div className="text-[9px] text-slate-400 truncate">
                              HASH: <span className="text-cyan-400/80">{ev.event_hash.slice(0, 16)}...</span> | PREV: <span className="text-slate-500">{ev.previous_event_hash ? ev.previous_event_hash.slice(0, 12) + "..." : "genesis"}</span>
                            </div>
                          )}
                          {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                            <pre className="text-[9px] bg-black/40 p-2 rounded text-slate-300 overflow-x-auto max-h-24">
                              {JSON.stringify(ev.metadata, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* TAB 4: NOTIFICATIONS & WEBHOOKS */}
              {activeTab === "notifications" && (
                <div className="space-y-5">
                  <div>
                    <h4 className="text-xs font-mono uppercase tracking-widest text-cyan-300 font-bold">Alert Channels &amp; Webhooks</h4>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Configure owner notification channels for security events.</p>
                  </div>

                  <div className="p-4 rounded-2xl border border-white/10 bg-white/5 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold text-white">SMTP Email Testing</span>
                      <button onClick={handleTestSmtp} className="px-3 py-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 text-xs font-mono font-semibold transition">
                        Test SMTP
                      </button>
                    </div>
                    {testEmailResult && (
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-white/5 text-xs font-mono text-slate-300">
                        {testEmailResult}
                      </div>
                    )}
                  </div>

                  <div className="p-4 rounded-2xl border border-white/10 bg-white/5 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold text-white">Webhook Notification Test</span>
                      <button onClick={handleTestWebhook} className="px-3 py-1.5 rounded-xl border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 text-xs font-mono font-semibold transition">
                        Test Webhook
                      </button>
                    </div>
                    {testWebhookResult && (
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-white/5 text-xs font-mono text-slate-300">
                        {testWebhookResult}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 5: SYSTEM & SHUTDOWN */}
              {activeTab === "system" && (
                <div className="space-y-5">
                  <div>
                    <h4 className="text-xs font-mono uppercase tracking-widest text-cyan-300 font-bold">System Power &amp; Graceful Shutdown</h4>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Control background operation and stop the SARA service safely.</p>
                  </div>

                  <div className="p-5 rounded-2xl border border-rose-500/30 bg-rose-950/20 space-y-3">
                    <div className="flex items-center gap-2 text-rose-300 text-xs font-mono font-bold">
                      <Power size={16} /> Stop SARA Background Service
                    </div>
                    <p className="text-[10px] font-mono text-slate-400 leading-relaxed">
                      SARA will gracefully save active task checkpoints, flush the memory queue to SQLite, close database connections, and stop the background process cleanly.
                    </p>
                    <button onClick={handleShutdownSara} className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-mono font-bold tracking-wider uppercase transition cursor-pointer">
                      Shut Down SARA Service Now
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-white/5 bg-slate-950 flex items-center justify-between text-[10px] font-mono text-slate-500 uppercase tracking-widest">
              <span>SARA Security Engine</span>
              <span>Local-First &amp; Privacy Preserving</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
