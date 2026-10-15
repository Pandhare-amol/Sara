import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BatteryCharging, BatteryWarning, Cpu, HardDrive, MemoryStick, RefreshCw, ShieldAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { SystemResourceAlert, SystemResourceSnapshot } from "../services/SystemResourceMonitor";

interface SystemMonitorPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenMonitor: () => void;
}

function loadAdminHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const token = sessionStorage.getItem("sara.adminToken") || "";
    const passkeySession = sessionStorage.getItem("sara.adminPasskeySession") || "";
    if (token) headers["x-admin-token"] = token;
    if (passkeySession) headers["x-sara-admin-session"] = passkeySession;
  } catch { /* storage may be unavailable */ }
  return headers;
}

function ResourceGauge({ label, value, icon: Icon, highAt }: { label: string; value: number | null; icon: typeof Cpu; highAt: number }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value));
  const high = value !== null && value >= highAt;
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-300">
          <Icon size={15} className={high ? "text-amber-300" : "text-cyan-300"} /> {label}
        </div>
        <span className={`font-mono text-lg ${high ? "text-amber-200" : "text-white"}`}>{value === null ? "—" : `${value.toFixed(1)}%`}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`${label} usage`} aria-valuenow={value ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-all ${high ? "bg-amber-400" : "bg-cyan-400"}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Warning threshold: {highAt}%</p>
    </div>
  );
}

export function SystemMonitorPanel({ isOpen, onClose, onOpenMonitor }: SystemMonitorPanelProps) {
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeAlert, setActiveAlert] = useState<SystemResourceAlert | null>(null);
  const [closingPid, setClosingPid] = useState<number | null>(null);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const lastSeenAlertTime = useRef(Date.now() - 60_000);
  const seenAlertIds = useRef(new Set<string>());

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const since = Math.max(0, lastSeenAlertTime.current - 1);
      const response = await fetch(`/api/system/resources?since=${since}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Local system monitoring is unavailable.");
      if (payload.snapshot && typeof payload.snapshot === "object") setSnapshot(payload.snapshot as SystemResourceSnapshot);
      setLoadError(null);
      const newAlerts = (Array.isArray(payload.alerts) ? payload.alerts : []) as SystemResourceAlert[];
      const unseen = newAlerts.filter((alert) => alert?.id && !seenAlertIds.current.has(alert.id));
      for (const alert of unseen) seenAlertIds.current.add(alert.id);
      if (unseen.length) {
        unseen.sort((left, right) => left.createdAt - right.createdAt);
        const newest = unseen[unseen.length - 1];
        setActiveAlert(newest);
        lastSeenAlertTime.current = Math.max(lastSeenAlertTime.current, ...unseen.map((alert) => Number(alert.createdAt) || 0));
      }
      if (seenAlertIds.current.size > 200) {
        seenAlertIds.current = new Set(Array.from(seenAlertIds.current).slice(-100));
      }
    } catch (error: any) {
      setLoadError(error?.message || "Local system monitoring is unavailable.");
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const requestGracefulClose = async (process: SystemResourceSnapshot["processes"][number]) => {
    setCloseMessage(null);
    const adminHeaders = loadAdminHeaders();
    if (!adminHeaders["x-admin-token"] && !adminHeaders["x-sara-admin-session"]) {
      setCloseMessage("Admin verification is required. Open Security and sign in before requesting an app close.");
      return;
    }
    const approved = window.confirm(
      `Request a graceful close for ${process.name} (PID ${process.pid})?\n\nThe app may ask you to save work. SARA will not force-kill it. If it does not close, it will be left running.`,
    );
    if (!approved) return;

    setClosingPid(process.pid);
    try {
      const response = await fetch(`/api/system/processes/${process.pid}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ confirmed: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || payload?.verified !== true) {
        throw new Error(payload?.error || "The app was not verified as closed. It was not force-killed.");
      }
      setCloseMessage(`${process.name} closed gracefully and the result was verified.`);
      await refresh();
    } catch (error: any) {
      setCloseMessage(error?.message || "The app was not closed. No force-kill was attempted.");
    } finally {
      setClosingPid(null);
    }
  };

  return (
    <>
      <AnimatePresence>
        {activeAlert && !isOpen && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-5 right-5 z-[55] flex max-w-md items-start gap-3 rounded-xl border border-amber-400/35 bg-slate-950/95 p-4 text-amber-50 shadow-2xl backdrop-blur"
          >
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">System resource warning</p>
              <p className="mt-1 text-xs leading-relaxed">{activeAlert.message}</p>
              <button type="button" onClick={() => { setActiveAlert(null); onOpenMonitor(); }} className="mt-2 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:text-white">Review system monitor</button>
            </div>
            <button type="button" onClick={() => setActiveAlert(null)} className="text-amber-200 hover:text-white" aria-label="Dismiss system warning"><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.button
              type="button"
              aria-label="Close system monitor overlay"
              className="fixed inset-0 z-[58] bg-black/65 backdrop-blur-sm"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-labelledby="system-monitor-title"
              initial={{ opacity: 0, x: 32 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 32 }}
              className="fixed inset-y-0 right-0 z-[59] flex w-full max-w-2xl flex-col border-l border-cyan-300/15 bg-slate-950 text-white shadow-2xl"
            >
              <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div>
                  <h2 id="system-monitor-title" className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em]"><Activity size={17} className="text-cyan-300" /> System monitor</h2>
                  <p className="mt-1 text-[10px] text-slate-500">Local CPU, memory, battery and top processes. Samples update every 10 seconds.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void refresh(true)} disabled={loading} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-200 disabled:opacity-50" aria-label="Refresh system monitor"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button>
                  <button type="button" onClick={onClose} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white" aria-label="Close system monitor"><X size={15} /></button>
                </div>
              </header>

              <div className="flex-1 space-y-5 overflow-y-auto p-5">
                {loadError && <div className="rounded-lg border border-rose-400/30 bg-rose-950/30 p-3 text-xs text-rose-200" role="status">{loadError}</div>}
                {closeMessage && <div className="rounded-lg border border-cyan-300/20 bg-cyan-950/25 p-3 text-xs text-cyan-100" role="status">{closeMessage}</div>}

                <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="System resource usage">
                  <ResourceGauge label="CPU" value={snapshot?.cpuPercent ?? null} icon={Cpu} highAt={85} />
                  <ResourceGauge label="Memory" value={snapshot?.memoryPercent ?? null} icon={MemoryStick} highAt={92} />
                  <div>
                    <ResourceGauge label="Disk" value={snapshot?.disk.available ? snapshot.disk.percent : null} icon={HardDrive} highAt={92} />
                    {snapshot?.disk.available && snapshot.disk.used && snapshot.disk.total && <p className="px-2 pt-1 text-[9px] text-slate-500">{snapshot.disk.used} / {snapshot.disk.total} {snapshot.disk.mountpoint ? `· ${snapshot.disk.mountpoint}` : ""}</p>}
                  </div>
                </section>

                <section className="rounded-xl border border-white/10 bg-slate-900/60 p-4" aria-label="Battery status">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-300">
                    {snapshot?.battery.plugged ? <BatteryCharging size={15} className="text-emerald-300" /> : <BatteryWarning size={15} className={snapshot?.battery.percent !== null && snapshot?.battery.percent !== undefined && snapshot.battery.percent <= 20 ? "text-amber-300" : "text-cyan-300"} />}
                    Battery
                  </div>
                  {snapshot?.battery.available && snapshot.battery.percent !== null ? (
                    <div className="mt-2 flex items-baseline gap-2"><span className={`font-mono text-2xl ${snapshot.battery.percent <= 20 && !snapshot.battery.plugged ? "text-amber-200" : "text-white"}`}>{snapshot.battery.percent}%</span><span className="text-xs text-slate-400">{snapshot.battery.plugged ? "Charging / connected" : "On battery"}</span></div>
                  ) : <p className="mt-2 text-xs text-slate-500">Battery status is not available on this device.</p>}
                  {snapshot?.battery.available && snapshot.battery.percent !== null && snapshot.battery.percent <= 20 && !snapshot.battery.plugged && <p className="mt-2 text-xs text-amber-200">Low battery: connect the charger soon.</p>}
                </section>

                <section className="rounded-xl border border-white/10 bg-slate-900/50">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div><h3 className="text-xs font-bold uppercase tracking-widest text-slate-200">Top processes</h3><p className="mt-1 text-[10px] text-slate-500">Close requests appear only for sustained high-use, unprotected apps.</p></div>
                    <span className="text-[10px] text-slate-500">{snapshot?.processes.length ?? 0} shown</span>
                  </div>
                  {snapshot?.processes.length ? (
                    <ul className="divide-y divide-white/5">
                      {snapshot.processes.map((process) => (
                        <li key={`${process.pid}-${process.name}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-white">{process.name} <span className="font-mono text-[10px] font-normal text-slate-500">PID {process.pid}</span></p>
                            <p className="mt-1 text-[10px] text-slate-400">CPU {process.cpuPercent.toFixed(1)}% · RAM {process.memoryPercent.toFixed(1)}%</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {process.protected ? <span className="rounded-full border border-slate-600 px-2 py-1 text-[9px] uppercase tracking-wider text-slate-400">Protected</span> : process.highUsage ? <span className="rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-wider text-amber-200">High use</span> : <span className="rounded-full border border-emerald-300/20 px-2 py-1 text-[9px] uppercase tracking-wider text-emerald-200">Normal</span>}
                            {process.highUsage && !process.protected && <button type="button" onClick={() => void requestGracefulClose(process)} disabled={closingPid !== null} className="rounded-lg border border-amber-300/30 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider text-amber-100 hover:bg-amber-500/10 disabled:cursor-wait disabled:opacity-50">{closingPid === process.pid ? "Requesting…" : "Review close"}</button>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="px-4 py-6 text-center text-xs text-slate-500">No process data yet.</p>}
                </section>

                <p className="text-[10px] leading-relaxed text-slate-500">Alerts require repeated samples: CPU ≥85%, memory or disk ≥92%, or an app ≥60% CPU / ≥20% RAM. Low-battery alerts trigger at 20% while unplugged. Closing an app requires admin verification and a separate confirmation; SARA sends a graceful-close request only and never force-kills a process.</p>
              </div>
              <footer className="border-t border-white/10 px-5 py-3 text-[10px] text-slate-600">Last sample: {snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : "waiting for local agent"}</footer>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
