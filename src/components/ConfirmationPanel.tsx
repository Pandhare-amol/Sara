import React, { useEffect, useState } from 'react';

export function ConfirmationPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [tokenById, setTokenById] = useState<Record<string,string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/confirm/list');
      const j = await r.json();
      if (j && j.confirmations) setList(j.confirmations);
    } catch (e) { console.warn('load confirmations failed', e); }
    setLoading(false);
  };

  useEffect(() => { load(); const iv = setInterval(load, 4000); return () => clearInterval(iv); }, []);

  const verify = async (id: string) => {
    const token = tokenById[id];
    if (!token) { alert('Enter token'); return; }
    setVerifying(true);
    try {
      const r = await fetch('/api/confirm/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, token }) });
      const j = await r.json();
      if (j && j.ok) {
        alert('Confirmed');
        load();
      } else {
        alert('Confirm failed: ' + (j?.error || JSON.stringify(j)));
      }
    } catch (e) { alert('Verify failed: ' + e); }
    setVerifying(false);
  };

  if (loading) return <div className="p-4">Loading confirmations...</div>;

  return (
    <div className="fixed right-6 top-20 z-50 w-96 p-4 rounded-lg bg-slate-900/90 border border-white/6 shadow-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <strong>Confirmations</strong>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-xs text-slate-300">Close</button>
        </div>
      </div>
      <div className="space-y-2 max-h-[60vh] overflow-auto">
        {list.length === 0 && <div className="text-xs text-slate-400">No pending confirmations.</div>}
        {list.map((c) => (
          <div key={c.id} className="p-2 rounded bg-black/20">
            <div className="flex items-center justify-between">
              <div className="font-medium">{c.action || 'action'}</div>
              <div className="text-xs">id: {c.id}</div>
            </div>
            <div className="text-xs text-slate-400 pt-1">args: {JSON.stringify(c.args || {})}</div>
            <div className="pt-2 flex gap-2 items-center">
              <input placeholder="token" value={tokenById[c.id] || ''} onChange={(e)=>setTokenById(s=>({...s,[c.id]:e.target.value}))} className="p-1 bg-transparent border rounded text-xs w-40" />
              <button onClick={()=>verify(c.id)} className="px-2 py-1 bg-indigo-600 rounded text-xs" disabled={verifying}>Verify</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
