import { useEffect, useState } from "react";
import { setVisualToken, visualHeaders } from "../lib/visualClient";

/** Persistent (while the app is open) indicator, independent of the task panel. */
export function VisualAccessIndicator({ onOpen, browserSharing, browserPaused, onStopBrowserSharing }: {
  onOpen: () => void; browserSharing: boolean; browserPaused: boolean; onStopBrowserSharing: () => void;
}) {
  const [active, setActive] = useState(false);
  const [orphaned, setOrphaned] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [warning, setWarning] = useState("");
  useEffect(() => {
    let alive = true;
    const update = async () => {
      try {
        const res = await fetch("/api/visual/access", { cache: "no-store", mode: "same-origin", redirect: "error" });
        const data = await res.json();
        if (alive) {
          setActive(res.ok && data.enabled === true);
          setOrphaned(res.ok && data.agent_enabled_without_browser_grant === true);
          setUncertain(!res.ok || data.agent_online === false);
        }
      } catch { if (alive) { setActive(false); setOrphaned(false); setUncertain(true); } }
    };
    void update();
    const interval = window.setInterval(() => { void update(); }, 2500);
    return () => { alive = false; window.clearInterval(interval); };
  }, []);
  const stop = async () => {
    if (browserSharing) onStopBrowserSharing();
    if (!active) return;
    const headers = visualHeaders();
    setVisualToken(null);
    setStopping(true); setActive(false);
    try {
      const response = await fetch("/api/visual/access", { method: "DELETE", headers,
        mode: "same-origin", redirect: "error", cache: "no-store" });
      if (!response.ok) setWarning("Windows-agent stop was not confirmed. Open Tasks to review or re-authorize.");
      else setWarning("");
    } catch { setWarning("Windows-agent stop was not confirmed. Open Tasks to review."); }
    finally { setStopping(false); }
  };
  return <div className="flex items-center gap-1 text-[10px] font-mono" role="status" aria-live="polite">
    <button type="button" onClick={onOpen} aria-label="Open screen access controls"
      className={`rounded-lg border px-2 py-1 ${active || browserSharing || orphaned || uncertain ? "border-amber-400/60 bg-amber-400/10 text-amber-200" : "border-white/10 text-white/40"}`}>
      {active ? "SCREEN ACCESS ON" : browserSharing ? browserPaused ? "SCREEN SHARE PAUSED" : "SCREEN SHARE ON" :
        orphaned ? "SCREEN ACCESS REVIEW" : uncertain ? "SCREEN STATUS UNKNOWN" : "SCREEN OFF"}
    </button>
    {(active || browserSharing || orphaned) && <button type="button" disabled={stopping || (orphaned && !browserSharing)} onClick={stop}
      className="rounded-lg border border-rose-400/50 px-2 py-1 text-rose-200 disabled:opacity-40"
      title={orphaned && !browserSharing ? "Re-enter admin approval in Tasks to stop the native grant" : "Stop approved sharing and/or revoke native screen access"}>
      Stop</button>}
    {warning && <button type="button" onClick={onOpen} className="text-rose-300" title={warning}>Review</button>}
  </div>;
}
