// src/components/SelfImprovementDashboard.tsx
import React, { useEffect, useState } from "react";
import { EventBus } from "../core/events/EventBus";
import { Activity } from "lucide-react";

interface PatchInfo {
  file: string;
  description: string;
  diff: string;
}

/**
 * Simple dashboard showing recent self‑improvement patches.
 * It subscribes to the "patchGenerated" and "patchApplied" events emitted by the
 * self‑improvement engine and displays a list of suggestions and their status.
 */
export function SelfImprovementDashboard() {
  const [suggestions, setSuggestions] = useState<PatchInfo[]>([]);
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onGenerated = (payload: any) => {
      const { file, description, diff } = payload;
      setSuggestions((prev) => [...prev, { file, description, diff }]);
    };
    const onApplied = (payload: any) => {
      const { suggestion, applied: wasApplied } = payload;
      if (suggestion?.file) {
        setApplied((prev) => ({ ...prev, [suggestion.file]: wasApplied }));
      }
    };
    EventBus.instance.onEvent("patchGenerated", onGenerated);
    EventBus.instance.onEvent("patchApplied", onApplied);
    return () => {
      // Cleanup listeners
      EventBus.instance.removeAllListeners?.("patchGenerated");
      EventBus.instance.removeAllListeners?.("patchApplied");
    };
  }, []);

  return (
    <div className="space-y-4 p-4">
      <h3 className="text-sm font-mono uppercase text-cyan-300">Self‑Improvement Activity</h3>
      {suggestions.length === 0 ? (
        <p className="text-xs text-slate-400">No patches generated yet.</p>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((s, i) => (
            <li key={i} className="border border-white/10 rounded-xl bg-slate-900/60 p-3 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="font-bold text-cyan-300">{s.file}</span>
                <span className={`px-2 py-0.5 rounded ${applied[s.file] ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>
                  {applied[s.file] ? "APPLIED" : "PENDING"}
                </span>
              </div>
              <p className="mt-1 text-slate-300">{s.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
