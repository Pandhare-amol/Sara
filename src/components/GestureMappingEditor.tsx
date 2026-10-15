import React, { useEffect, useState } from 'react';

function getAdminHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const adminToken = sessionStorage.getItem('sara.adminToken');
    const passkeySession = sessionStorage.getItem('sara.adminPasskeySession');
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    if (passkeySession) headers['X-SARA-Admin-Session'] = passkeySession;
  } catch {
    // The backend rejects writes when no admin credential is available.
  }
  return headers;
}

async function readJsonResponse(response: Response): Promise<Record<string, any>> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed with HTTP ${response.status}.`);
  }
  return payload;
}

export function GestureMappingEditor({ onClose }: { onClose: () => void }) {
  const [mappings, setMappings] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/gesture/mappings/get', { method: 'POST' });
      const payload = await readJsonResponse(response);
      if (!payload.mappings || typeof payload.mappings !== 'object' || Array.isArray(payload.mappings)) {
        throw new Error('The Desktop Agent returned an invalid gesture mapping set.');
      }
      setMappings(payload.mappings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load gesture mappings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const updateGesture = (name: string, field: string, value: unknown) => {
    setMappings((current: any) => ({ ...current, [name]: { ...(current[name] || {}), [field]: value } }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/gesture/mappings/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAdminHeaders() },
        body: JSON.stringify({ mappings }),
      });
      await readJsonResponse(response);
      window.alert('Mappings saved.');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save gesture mappings.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-4">Loading mappings...</div>;

  return (
    <div className="fixed left-6 top-20 z-50 w-[520px] p-4 rounded-lg bg-slate-900/90 border border-white/6 shadow-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <strong>Gesture Mappings</strong>
        <button onClick={onClose} className="text-xs text-slate-300">Close</button>
      </div>
      {error && <div role="alert" className="mb-2 rounded border border-rose-500/30 bg-rose-950/30 px-2 py-1 text-xs text-rose-300">{error}</div>}
      <div className="space-y-2 max-h-[60vh] overflow-auto">
        {Object.keys(mappings).map((name) => (
          <div key={name} className="p-2 rounded bg-black/20">
            <div className="flex items-center justify-between">
              <div className="font-medium">{name}</div>
              <div className="text-xs">Tool: <input className="ml-2 p-1 bg-transparent border rounded text-xs" value={mappings[name].tool || ''} onChange={(event) => updateGesture(name, 'tool', event.target.value)} /></div>
            </div>
            <div className="flex gap-2 pt-2">
              <label className="text-xs flex items-center gap-1">Requires Confirmation <input type="checkbox" checked={Boolean(mappings[name].requires_confirmation)} onChange={(event) => updateGesture(name, 'requires_confirmation', event.target.checked)} /></label>
              <label className="text-xs">Args (JSON) <input className="ml-2 p-1 bg-transparent border rounded text-xs w-64" value={JSON.stringify(mappings[name].args || {})} onChange={(event) => { try { updateGesture(name, 'args', JSON.parse(event.target.value)); } catch { /* keep the last valid JSON value */ } }} /></label>
            </div>
          </div>
        ))}
      </div>
      <div className="pt-3 flex justify-end gap-2">
        <button onClick={() => void save()} className="px-3 py-1 bg-indigo-600 rounded text-sm" disabled={saving}>Save</button>
        <button onClick={onClose} className="px-3 py-1 bg-gray-700 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}
