import React, { useEffect, useState, useRef } from 'react';
import { GestureMappingEditor } from './GestureMappingEditor';

export function GestureControlPanel({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationSteps] = useState(["center","top_left","top_right","bottom_left","bottom_right"]);
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [calPoints, setCalPoints] = useState<any>({});
  const pollRef = useRef<number | null>(null);

  const enable = async () => {
    try {
      const r = await fetch('/api/vision/enable', { method: 'POST' });
      const j = await r.json();
      if (j.ok !== false) setEnabled(true);
      startPolling();
    } catch (e) { console.warn('enable failed', e); }
  };
  const disable = async () => {
    try {
      await fetch('/api/vision/disable', { method: 'POST' });
      setEnabled(false);
      stopPolling();
      setState(null);
    } catch (e) { console.warn('disable failed', e); }
  };

  const fetchState = async () => {
    try {
      const r = await fetch('/api/vision/state');
      const j = await r.json();
      if (j && j.result) setState(j.result);
    } catch (e) { /* ignore */ }
  };

  const fetchConfig = async () => {
    try {
      const r = await fetch('/api/desktop/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'gestureControlGetConfig', args: {} })
      });
      const j = await r.json();
      if (j && j.result) setConfig(j.result);
    } catch (e) { /* ignore */ }
  };

  const startCalibration = () => {
    setCalibrating(true);
    setCalibrationIndex(0);
    setCalPoints({});
  };

  const [showMappingEditor, setShowMappingEditor] = useState(false);

  const openMappingEditor = () => setShowMappingEditor(true);


  const captureCalibrationPoint = async () => {
    try {
      const r = await fetch('/api/vision/state');
      const j = await r.json();
      const hand = j?.result?.hands?.[0];
      if (!hand) { alert('No hand detected. Please place your hand in view.'); return; }
      const { x, y } = hand.centroid;
      const step = calibrationSteps[calibrationIndex];
      const next = { ...calPoints, [step]: [x, y] };
      setCalPoints(next);
      if (calibrationIndex + 1 >= calibrationSteps.length) {
        // finish
        await fetch('/api/desktop/execute', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'gestureControlSetConfig', args:{config:{calibration: {
          camera_top_left: next.top_left,
          camera_top_right: next.top_right,
          camera_bottom_left: next.bottom_left,
          camera_bottom_right: next.bottom_right,
          camera_center: next.center,
          screen_top_left: [0,0],
          screen_top_right: [window.screen.width,0],
          screen_bottom_left: [0,window.screen.height],
        }}}})});
        setCalibrating(false);
        fetchConfig();
        alert('Calibration saved.');
      } else {
        setCalibrationIndex(calibrationIndex + 1);
      }
    } catch (e) { alert('Calibration capture failed: ' + e); }
  };

  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(fetchState, 500) as unknown as number;
    fetchState();
    fetchConfig();
  };
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  return (
    <div className="fixed right-6 top-20 z-50 w-96 p-4 rounded-lg bg-slate-900/90 border border-white/6 shadow-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <strong>Gesture Control</strong>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-xs text-slate-300">Close</button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>Gesture Control</div>
          <div>{enabled ? <span className="text-green-400">ON</span> : <span className="text-rose-400">OFF</span>}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={enable} className="px-2 py-1 bg-indigo-600 rounded">Enable</button>
          <button onClick={disable} className="px-2 py-1 bg-gray-700 rounded">Disable</button>
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Vision State</div>
          <div className="mt-1 p-2 rounded bg-black/40 text-xs">
            <div>status: {state?.status ?? 'unknown'}</div>
            <div>hands_detected: {state?.hands_detected ?? 0}</div>
            <div>fps: {state?.fps ?? '-'}</div>
            <div>latency_ms: {state?.latency_ms ?? '-'}</div>
            <div>gestures: {Array.isArray(state?.gestures) ? state.gestures.map((g: any)=>g.name).join(', ') : '-'}</div>
          </div>
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Gesture Config</div>
          <div className="mt-1 p-2 rounded bg-black/30 text-xs">
            <div>min_confidence: {config?.min_confidence ?? '0.85'}</div>
            <div>frames_required: {config?.frames_required ?? '3'}</div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button onClick={async () => {
              const next = { ...(config || {}), min_confidence: 0.9 };
              await fetch('/api/desktop/execute', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'gestureControlSetConfig', args:{config: next}})});
              fetchConfig();
            }} className="px-2 py-1 bg-indigo-600 rounded text-xs">Increase Confidence</button>
            <button onClick={async () => {
              const next = { ...(config || {}), min_confidence: 0.75 };
              await fetch('/api/desktop/execute', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'gestureControlSetConfig', args:{config: next}})});
              fetchConfig();
            }} className="px-2 py-1 bg-gray-700 rounded text-xs">Lower Confidence</button>
          </div>
        </div>
        <div className="pt-2">
          <div className="text-xs text-slate-400">Mappings</div>
          <div className="mt-1">
            <button onClick={openMappingEditor} className="px-2 py-1 bg-indigo-600 rounded text-xs">Edit Mappings</button>
          </div>
        </div>
        <div className="pt-2">
          <div className="text-xs text-slate-400">Calibration</div>
          {!calibrating && <div className="mt-1"><button onClick={startCalibration} className="px-2 py-1 bg-indigo-600 rounded text-xs">Start Calibration</button></div>}
          {calibrating && (
            <div className="mt-1 p-2 rounded bg-black/30 text-xs">
              <div>Step: {calibrationSteps[calibrationIndex]}</div>
              <div className="flex gap-2 pt-2">
                <button onClick={captureCalibrationPoint} className="px-2 py-1 bg-green-600 rounded text-xs">Capture Point</button>
                <button onClick={() => setCalibrating(false)} className="px-2 py-1 bg-red-700 rounded text-xs">Cancel</button>
              </div>
            </div>
          )}
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Last Action</div>
          <div className="mt-1 p-2 rounded bg-black/30 text-xs">{state?.last_action ?? '-'}</div>
        </div>

        <div className="pt-2 text-xs text-slate-500">Tip: Use calibration in Settings for accurate pointing.</div>
      </div>
      {showMappingEditor && <div><GestureMappingEditor onClose={()=>setShowMappingEditor(false)} /></div>}
    </div>
  );
}
