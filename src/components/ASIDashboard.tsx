import React, { useState, useEffect } from 'react';
import { InnovationReport, InnovationTarget, IntrospectionResult, EmotionalProfile } from '../asi/types';

export const ASIDashboard: React.FC = () => {
  const [reports, setReports] = useState<InnovationReport[]>([]);
  const [targets, setTargets] = useState<InnovationTarget[]>([]);
  const [profile, setProfile] = useState<EmotionalProfile | null>(null);
  const [introspectionLogs, setIntrospectionLogs] = useState<IntrospectionResult[]>([]);
  const [question, setQuestion] = useState("");
  const [reasoning, setReasoning] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runReasoning = async () => {
    if (!question.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/cognitive/advanced-reasoning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, domains: ["technology", "business"], depthLevel: 3 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Advanced reasoning unavailable");
      setReasoning(data.result);
    } catch (err: any) {
      setError(err?.message || "Advanced reasoning unavailable");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-gray-900 text-white min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">ASI Intelligence Center</h1>
        <div className="px-3 py-1 bg-green-900/50 text-green-400 rounded-full text-sm font-bold border border-green-700">
          BOUNDED REASONING
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="col-span-1 lg:col-span-2 border border-cyan-700/50 p-5 rounded-lg bg-gray-800/80 shadow-xl backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-2 text-cyan-300">Advanced reasoning assessment</h2>
          <p className="text-xs text-gray-400 mb-3">SARA synthesizes bounded evidence and hypotheses. It cannot execute actions from this panel.</p>
          <div className="flex gap-2">
            <input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runReasoning(); }} placeholder="Ask a complex question..." className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white" />
            <button onClick={() => void runReasoning()} disabled={loading || !question.trim()} className="rounded bg-cyan-600 px-4 py-2 text-sm disabled:opacity-50">{loading ? "Assessing..." : "Assess"}</button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
          {reasoning && <div className="mt-4 grid gap-3 text-sm">
            <p className="text-white">{reasoning.answer}</p>
            <p className="text-xs text-cyan-300">Confidence: {Math.round((reasoning.confidence || 0) * 100)}% · Confirmation required before action.</p>
            <div className="grid gap-2 md:grid-cols-3 text-xs text-gray-300">
              <div><strong className="text-amber-300">Assumptions:</strong> {(reasoning.assumptions || []).join("; ") || "None listed"}</div>
              <div><strong className="text-rose-300">Risks:</strong> {(reasoning.risks || []).join("; ") || "None listed"}</div>
              <div><strong className="text-slate-300">Evidence gaps:</strong> {(reasoning.evidenceGaps || []).join("; ") || "None listed"}</div>
            </div>
          </div>}
        </div>
        <div className="border border-gray-700 p-5 rounded-lg bg-gray-800/80 shadow-xl backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-3 text-blue-400 flex items-center">
            <span className="text-2xl mr-2">🧠</span> Emotional & Cognitive State
          </h2>
          {profile ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-900 p-3 rounded border border-gray-700">
                <p className="text-gray-400 text-xs">Valence</p>
                <p className="text-lg font-mono">{profile.valence.toFixed(2)}</p>
              </div>
              <div className="bg-gray-900 p-3 rounded border border-gray-700">
                <p className="text-gray-400 text-xs">Arousal</p>
                <p className="text-lg font-mono">{profile.arousal.toFixed(2)}</p>
              </div>
              <div className="bg-gray-900 p-3 rounded border border-gray-700">
                <p className="text-gray-400 text-xs">Stress Level</p>
                <p className="text-lg font-mono">{(profile.stressLevel * 100).toFixed(0)}%</p>
              </div>
              <div className="bg-gray-900 p-3 rounded border border-gray-700">
                <p className="text-gray-400 text-xs">Dominant Emotion</p>
                <p className="text-lg capitalize text-blue-300">{profile.dominantEmotion}</p>
              </div>
            </div>
          ) : (
            <div className="animate-pulse flex space-x-4">
              <div className="flex-1 space-y-4 py-1">
                <div className="h-4 bg-gray-600 rounded w-3/4"></div>
                <div className="h-4 bg-gray-600 rounded"></div>
                <div className="h-4 bg-gray-600 rounded w-5/6"></div>
              </div>
            </div>
          )}
        </div>

        <div className="border border-purple-700/50 p-5 rounded-lg bg-gray-800/80 shadow-xl shadow-purple-900/20 backdrop-blur-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-600/10 rounded-full blur-3xl"></div>
          <h2 className="text-xl font-semibold mb-3 text-purple-400 flex items-center">
            <span className="text-2xl mr-2">⚙️</span> Recursive Self-Improvement
          </h2>
          <div className="space-y-3 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
            {introspectionLogs.length === 0 ? (
              <div className="text-center py-6 text-gray-500 border border-dashed border-gray-700 rounded">
                Monitoring system processes...
              </div>
            ) : null}
            {introspectionLogs.map(log => (
              <div key={log.cycleId} className="bg-gray-900/80 border border-gray-700 p-3 rounded hover:border-purple-500/50 transition-colors">
                <div className="flex justify-between items-center mb-1">
                  <p className="text-sm font-semibold text-purple-300">{log.cycleId}</p>
                  <span className="text-xs px-2 py-0.5 bg-green-900/30 text-green-400 rounded">Success</span>
                </div>
                <p className="text-xs text-gray-400">Identified {log.bottlenecksIdentified.length} bottlenecks</p>
                <p className="text-xs font-mono text-green-300 mt-1">Proposed {log.patchesProposed} code patches for autonomy review</p>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-1 lg:col-span-2 border border-green-700/50 p-5 rounded-lg bg-gray-800/80 shadow-xl shadow-green-900/20 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-4 text-green-400 flex items-center">
            <span className="text-2xl mr-2">🚀</span> Autonomous Innovation Engine
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-gray-300 uppercase tracking-wider text-xs mb-3">Active Research Targets</h3>
              <div className="space-y-2">
                {targets.length === 0 ? <p className="text-sm text-gray-500 italic">No active targets seeded yet.</p> : null}
                {targets.map(t => (
                  <div key={t.id} className="bg-gray-900 p-3 rounded border border-gray-700 border-l-4 border-l-blue-500">
                    <p className="text-sm font-bold">{t.title}</p>
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{t.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.domains.map(d => (
                        <span key={d} className="px-2 py-0.5 bg-gray-800 rounded text-[10px] uppercase text-gray-300 border border-gray-700">{d}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-gray-300 uppercase tracking-wider text-xs mb-3">Cross-Domain Findings</h3>
              <div className="space-y-3">
                {reports.length === 0 ? <p className="text-sm text-gray-500 italic">Awaiting first breakthrough...</p> : null}
                {reports.map(r => (
                  <div key={r.id} className="bg-gray-900 p-3 rounded border border-green-900/50 relative overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-green-500"></div>
                    <div className="flex justify-between items-start">
                      <span className="px-2 py-0.5 bg-green-900/40 text-green-400 rounded text-xs font-mono">
                        Confidence: {(r.score * 100).toFixed(0)}%
                      </span>
                      <span className="text-gray-500 text-xs">{new Date(r.generatedAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-sm italic text-gray-200 mt-2">"{r.hypothesis}"</p>
                    {r.findings.length > 0 && (
                      <ul className="mt-2 list-disc list-inside text-xs text-gray-400 space-y-1">
                        {r.findings.slice(0,2).map((f, i) => <li key={i} className="truncate">{f}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
