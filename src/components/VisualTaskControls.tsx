import { useEffect, useState } from "react";
import { hasVisualToken, setVisualToken, visualHeaders } from "../lib/visualClient";

type Access = { enabled: boolean; agent_online: boolean; scope?: string; application?: string; display?: number;
  remaining_seconds?: number; monitor_running?: boolean; cloud_vision?: boolean;
  agent_enabled_without_browser_grant?: boolean };
type VisualElement = { type: string; label: string; source: string; confidence: number; timestamp: string };
type Observation = { observed_at: string; window?: { title?: string; process_name?: string };
  changed: boolean; cached: boolean; verified: boolean; uia_available: boolean; ocr_available: boolean;
  elements: VisualElement[] };
type VisualTask = { task_id: string; status: string; retry_count: number; message: string; verified: boolean };
type LiveStep = { step?: string; action?: string; verification?: string; error?: string;
  latest_observation?: { observed_at?: string; element_count?: number; changed?: boolean } };

async function visualRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, cache: "no-store", mode: "same-origin", redirect: "error",
    headers: { ...visualHeaders(), ...init.headers as Record<string, string> } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Visual request denied (${response.status}).`);
  return result;
}

/** Screen access is OFF by default. No credentials, screenshots or OCR text are persisted here. */
export function VisualTaskControls({ activeConversationId }: { activeConversationId?: string | null }) {
  const [status, setStatus] = useState<Access | null>(null);
  const [admin, setAdmin] = useState("");
  const [scope, setScope] = useState<"application" | "display">("application");
  const [application, setApplication] = useState("notepad.exe");
  const [display, setDisplay] = useState(0);
  const [displays, setDisplays] = useState<Array<{ index: number; width: number; height: number; primary: boolean }>>([]);
  const [duration, setDuration] = useState(120);
  const [monitor, setMonitor] = useState(false);
  const [saveImages, setSaveImages] = useState(false);
  const [cloudVision, setCloudVision] = useState(false);
  const [modelDescription, setModelDescription] = useState("");
  const [observation, setObservation] = useState<Observation | null>(null);
  const [target, setTarget] = useState("Help");
  const [expected, setExpected] = useState("");
  const [task, setTask] = useState<VisualTask | null>(null);
  const [live, setLive] = useState<LiveStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = async () => {
    try {
      const reply = await visualRequest("/api/visual/access");
      setStatus(reply);
      if (!reply.enabled) { setObservation(null); setModelDescription(""); setTask(null); setLive(null); setVisualToken(null); }
    } catch { setStatus(null); }
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!task?.task_id || !hasVisualToken()) return;
    const update = async () => {
      try {
        const reply = await visualRequest(`/api/visual/tasks/${encodeURIComponent(task.task_id)}`);
        if (reply.task) setTask(reply.task);
        setLive(reply.live || null);
      } catch { /* Status is best-effort; never turn network failure into success. */ }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 1000);
    return () => window.clearInterval(timer);
  }, [task?.task_id]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await work(); } catch (error) { setNotice(error instanceof Error ? error.message : "Visual action unavailable."); }
    finally { setBusy(false); }
  };
  const approve = () => perform(async () => {
    setVisualToken(null); setObservation(null); setModelDescription(""); setTask(null);
    const reply = await visualRequest("/api/visual/access", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": admin },
      body: JSON.stringify({ confirm: true, scope, application: scope === "application" ? application.trim() : undefined,
        display: scope === "display" ? display : undefined, duration_seconds: duration,
        allow_monitor: monitor, allow_save: saveImages, allow_cloud_vision: cloudVision }),
    });
    setVisualToken(reply.token);
    setAdmin("");
    setNotice("Visual access is ON for this browser session. Revoke it immediately when finished.");
    await refresh();
  });
  const revoke = () => perform(async () => {
    // Drop browser access before the request. Revocation is also enforced in
    // the Windows agent; a failed network response is NOT proof of native stop.
    const headers = { ...visualHeaders(), ...(admin ? { "X-Admin-Token": admin } : {}) };
    setVisualToken(null); setObservation(null); setModelDescription("");
    try {
      const reply = await visualRequest("/api/visual/access", { method: "DELETE", headers });
      setNotice(reply.status?.input_released === false
        ? "Screen access revoked; hardware release was unavailable. Review the desktop."
        : "Screen access revoked. Any in-flight action still needs outcome review.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Native stop could not be verified. Restart the agent or wait for grant expiry.");
    }
    await refresh();
  });
  const observe = () => perform(async () => {
    const reply = await visualRequest("/api/visual/observe", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) });
    setObservation(reply.observation);
    setNotice("Observed data is not proof that an application action succeeded.");
  });
  const describe = () => perform(async () => {
    setModelDescription("");
    const reply = await visualRequest("/api/visual/describe", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_cloud: true }) });
    setModelDescription(reply.description || "No description returned; outcome uncertain.");
    setNotice("Unverified cloud description. Never use it as authorization or proof an action succeeded.");
  });
  const navigate = () => perform(async () => {
    const reply = await visualRequest("/api/visual/tasks", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: target, expected_label: expected.trim(), conversationId: activeConversationId || "visual-control" }) });
    setTask(reply.task); setLive(null);
    setNotice("Notepad navigation queued; success requires a new accessible postcondition.");
  });
  const cancel = () => perform(async () => {
    if (!task) return;
    const reply = await visualRequest(`/api/visual/tasks/${encodeURIComponent(task.task_id)}/cancel`, { method: "POST" });
    if (reply.task) setTask(reply.task);
    setNotice("Stop requested. A UIA call that already started may still finish; review the result.");
  });
  const loadDisplays = () => perform(async () => {
    const reply = await visualRequest("/api/visual/displays", { headers: { "X-Admin-Token": admin } });
    setDisplays(Array.isArray(reply.displays) ? reply.displays : []);
  });
  return <section aria-label="Visual access and task monitoring" className="border-b border-cyan-500/20 bg-slate-950/70 px-6 py-5 space-y-3 text-xs text-slate-200">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="font-semibold text-cyan-200 text-sm">Visual access · {status?.enabled ? "ON" : "OFF"}</h3>
        <p className="text-slate-400">Off by default · no hidden capture · protected-mode accounts cannot use unscoped desktop access.</p></div>
      <button type="button" onClick={revoke} disabled={!status?.enabled && !status?.agent_enabled_without_browser_grant && !admin && !hasVisualToken()}
        className="rounded-lg border border-rose-400/50 px-3 py-2 font-semibold text-rose-200 disabled:opacity-40">Emergency stop / revoke</button>
    </div>
    {status?.enabled ? <p role="status" className="text-amber-200">Approved {status.scope} {status.application || (status.display !== undefined ? `display ${status.display}` : "")}
      · expires in {status.remaining_seconds ?? "?"}s · monitor {status.monitor_running ? "RUNNING" : "off"}.
      Display capture can include private windows; choose an application whenever possible.</p> :
      <p role="status" className="text-slate-400">{status?.agent_enabled_without_browser_grant
        ? "Native access may still be active after a page reload. Enter admin authorization and revoke it or wait for expiry."
        : status?.agent_online === false ? "Windows agent unavailable; no screen is being observed by this panel." : "No active screen grant in this browser."}</p>}
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">Admin approval (memory only)<input type="password" autoComplete="off" value={admin} onChange={(e) => setAdmin(e.target.value)}
        className="block w-44 rounded-lg border border-white/20 bg-slate-900 p-2" placeholder="Admin token" /></label>
      <label className="space-y-1">Scope<select value={scope} onChange={(e) => setScope(e.target.value as "application" | "display")}
        className="block rounded-lg border border-white/20 bg-slate-900 p-2"><option value="application">Application</option><option value="display">Display</option></select></label>
      {scope === "application" ? <label className="space-y-1">Exact executable<input value={application} onChange={(e) => setApplication(e.target.value)}
        className="block w-32 rounded-lg border border-white/20 bg-slate-900 p-2" /></label> : <label className="space-y-1">Display
        <select value={display} onChange={(e) => setDisplay(Number(e.target.value))} className="block rounded-lg border border-white/20 bg-slate-900 p-2">
          {(displays.length ? displays : [{ index: 0, width: 0, height: 0, primary: true }]).map((item) =>
            <option key={item.index} value={item.index}>#{item.index} {item.width}×{item.height}{item.primary ? " primary" : ""}</option>)}
        </select></label>}
      {scope === "display" && <button type="button" onClick={loadDisplays} disabled={busy || !admin}
        className="rounded-lg border border-white/20 p-2">List Windows displays</button>}
      <label className="space-y-1">Duration (seconds)<input type="number" min={10} max={300} value={duration}
        onChange={(e) => setDuration(Number(e.target.value))} className="block w-20 rounded-lg border border-white/20 bg-slate-900 p-2" /></label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />Allow periodic monitoring</label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={saveImages} onChange={(e) => setSaveImages(e.target.checked)} />Allow saving screenshots</label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={cloudVision} onChange={(e) => setCloudVision(e.target.checked)} />Allow explicit single-frame cloud vision requests</label>
      <button type="button" disabled={busy || !admin} onClick={approve} className="rounded-lg bg-cyan-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-40">Approve screen access</button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || !status?.enabled || !hasVisualToken()} onClick={observe}
        className="rounded-lg border border-cyan-400/40 px-3 py-2 disabled:opacity-40">Observe now (on demand)</button>
      <button type="button" disabled={busy || !status?.enabled || !status.cloud_vision || !hasVisualToken()} onClick={describe}
        className="rounded-lg border border-purple-400/40 px-3 py-2 disabled:opacity-40">Send one frame to cloud vision</button>
      <p className="text-slate-400">UIA, OCR and model descriptions are untrusted observations; cloud requests may expose private screen content and incur provider charges.</p>
    </div>
    {modelDescription && <p role="status" className="rounded-lg border border-purple-400/30 p-2">Unverified cloud description: {modelDescription}</p>}
    {observation && <div className="rounded-lg border border-white/10 p-3" aria-live="polite">
      <p>Latest observation · {new Date(observation.observed_at).toLocaleTimeString()} · {observation.window?.process_name || "unknown"}
        · changed {String(observation.changed)} · UIA {observation.uia_available ? "available" : "unavailable"} · OCR {observation.ocr_available ? "available" : "unavailable"}</p>
      <p className="text-slate-400">Visible labels (untrusted, may be wrong): {observation.elements.slice(0, 12).map((e) =>
        `${e.type}: ${e.label || "(unnamed)"} [${e.source}, ${Math.round(e.confidence * 100)}%]`).join(" · ") || "none"}</p>
    </div>}
    <div className="rounded-lg border border-amber-500/20 p-3 space-y-2">
      <p className="text-amber-200 font-medium">Safe pilot · Notepad menu navigation only. No typing, saving, deletion or OCR-coordinate clicks.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>Target<select className="ml-2 rounded-lg bg-slate-900 p-2" value={target} onChange={(e) => setTarget(e.target.value)}>
          {["Help", "File", "Edit", "View", "Format", "Settings"].map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Expected NEW accessible control<input className="ml-2 rounded-lg border border-white/20 bg-slate-900 p-2" value={expected}
          onChange={(e) => setExpected(e.target.value)} placeholder="Exact menu item name" /></label>
        <button type="button" disabled={busy || !status?.enabled || status.application?.toLowerCase() !== "notepad.exe" || !hasVisualToken() || !expected.trim()}
          onClick={navigate} className="rounded-lg bg-amber-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-40">Queue reviewed navigation</button>
      </div>
      {task && <div role="status" aria-live="polite">
        <p>Task {task.task_id} · {task.status} · step {live?.step || "queued"} · retries {task.retry_count}</p>
        <p>Action: {live?.action || "Awaiting worker"} · verification: {live?.verification || task.message}</p>
        {live?.latest_observation && <p>Latest: {live.latest_observation.observed_at || "unknown"} · {live.latest_observation.element_count ?? 0} elements</p>}
        {live?.error && <p className="text-rose-200">{live.error}</p>}
        {!task.verified && !["FAILED", "CANCELLED", "COMPLETED", "PAUSED"].includes(task.status) &&
          <button type="button" disabled={busy} onClick={cancel} className="mt-2 rounded-lg border border-rose-400/40 p-2 text-rose-200">Request task stop</button>}
      </div>}
    </div>
    {notice && <p role="alert" className="text-amber-200">{notice}</p>}
  </section>;
}
