import React, { useEffect, useState } from 'react';

export function GestureMappingEditor({ onClose }: { onClose: () => void }) {
  const [mappings, setMappings] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/desktop/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'gestureControlGetMappings', args: {} })
      });
      const j = await r.json();
      if (j && j.result) setMappings(j.result);
    } catch (e) { console.warn('load mappings failed', e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const updateGesture = (name: string, field: string, value: any) => {
    setMappings((s: any) => ({ ...s, [name]: { ...(s[name] || {}), [field]: value } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch('/api/desktop/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'gestureControlSetMappings', args: { mappings } }) });
      alert('Mappings saved');
      onClose();
    } catch (e) { alert('Save failed: ' + e); }
    setSaving(false);
  };

  if (loading) return <div className="p-4">Loading mappings...</div>;

  return (
    <div className="fixed left-6 top-20 z-50 w-[520px] p-4 rounded-lg bg-slate-900/90 border border-white/6 shadow-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <strong>Gesture Mappings</strong>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-xs text-slate-300">Close</button>
        </div>
      </div>
      <div className="space-y-2 max-h-[60vh] overflow-auto">
        {Object.keys(mappings).map((k) => (
          <div key={k} className="p-2 rounded bg-black/20">
            <div className="flex items-center justify-between">
              <div className="font-medium">{k}</div>
              <div className="text-xs">Tool: <input className="ml-2 p-1 bg-transparent border rounded text-xs" value={mappings[k].tool || ''} onChange={(e)=>updateGesture(k,'tool',e.target.value)} /></div>
            </div>
            <div className="flex gap-2 pt-2">
              <label className="text-xs flex items-center gap-1">Requires Confirmation <input type="checkbox" checked={Boolean(mappings[k].requires_confirmation)} onChange={(e)=>updateGesture(k,'requires_confirmation', e.target.checked)} /></label>
              <label className="text-xs">Args (JSON) <input className="ml-2 p-1 bg-transparent border rounded text-xs w-64" value={JSON.stringify(mappings[k].args||{})} onChange={(e)=>{ try { updateGesture(k,'args', JSON.parse(e.target.value)) } catch {}}} /></label>
            </div>
          </div>
        ))}
      </div>
      <div className="pt-3 flex justify-end gap-2">
        <button onClick={save} className="px-3 py-1 bg-indigo-600 rounded text-sm" disabled={saving}>Save</button>
        <button onClick={onClose} className="px-3 py-1 bg-gray-700 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}
