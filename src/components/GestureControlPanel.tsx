import React, { useEffect, useRef, useState } from 'react';
import { GestureMappingEditor } from './GestureMappingEditor';

function getAdminHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const adminToken = sessionStorage.getItem('sara.adminToken');
    const passkeySession = sessionStorage.getItem('sara.adminPasskeySession');
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    if (passkeySession) headers['X-SARA-Admin-Session'] = passkeySession;
  } catch {
    // The API will fail closed if session storage is unavailable.
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

export function GestureControlPanel({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationSteps] = useState(["center", "top_left", "top_right", "bottom_left", "bottom_right"]);
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [calPoints, setCalPoints] = useState<any>({});
  const [showMappingEditor, setShowMappingEditor] = useState(false);
  const pollRef = useRef<number | null>(null);

  const enable = async () => {
    try {
      const response = await fetch('/api/vision/enable', { method: 'POST' });
      await readJsonResponse(response);
      setEnabled(true);
      setVisionError(null);
      startPolling();
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Could not enable gesture control.');
      console.warn('enable failed', error);
    }
  };

  const disable = async () => {
    try {
      const response = await fetch('/api/vision/disable', { method: 'POST' });
      await readJsonResponse(response);
      setEnabled(false);
      setVisionError(null);
      stopPolling();
      setState(null);
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Could not disable gesture control.');
      console.warn('disable failed', error);
    }
  };

  const fetchState = async () => {
    try {
      const response = await fetch('/api/vision/state');
      const payload = await readJsonResponse(response);
      if (payload.result) {
        setState(payload.result);
        setVisionError(null);
      }
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Could not read gesture-control state.');
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/gesture/config');
      const payload = await readJsonResponse(response);
      if (payload.config && typeof payload.config === 'object') {
        setConfig(payload.config);
        setVisionError(null);
      }
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Gesture configuration is unavailable.');
    }
  };

  const saveConfig = async (nextConfig: Record<string, unknown>) => {
    const response = await fetch('/api/gesture/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAdminHeaders() },
      body: JSON.stringify({ config: nextConfig }),
    });
    const payload = await readJsonResponse(response);
    if (payload.config && typeof payload.config === 'object') setConfig(payload.config);
    setVisionError(null);
  };

  const updateConfidence = async (minConfidence: number) => {
    try {
      await saveConfig({ min_confidence: minConfidence });
      await fetchConfig();
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Could not update gesture confidence.');
    }
  };

  const startCalibration = () => {
    setCalibrating(true);
    setCalibrationIndex(0);
    setCalPoints({});
  };

  const captureCalibrationPoint = async () => {
    try {
      const response = await fetch('/api/vision/state');
      const payload = await readJsonResponse(response);
      const hand = payload?.result?.hands?.[0];
      if (!hand?.centroid || !Number.isFinite(hand.centroid.x) || !Number.isFinite(hand.centroid.y)) {
        throw new Error('No valid hand position was detected. Place your hand in view and try again.');
      }
      const step = calibrationSteps[calibrationIndex];
      const next = { ...calPoints, [step]: [hand.centroid.x, hand.centroid.y] };
      setCalPoints(next);
      if (calibrationIndex + 1 >= calibrationSteps.length) {
        await saveConfig({
          calibration: {
            camera_top_left: next.top_left,
            camera_top_right: next.top_right,
            camera_bottom_left: next.bottom_left,
            camera_bottom_right: next.bottom_right,
            camera_center: next.center,
            screen_top_left: [0, 0],
            screen_top_right: [window.screen.width, 0],
            screen_bottom_left: [0, window.screen.height],
          },
        });
        setCalibrating(false);
        await fetchConfig();
        window.alert('Calibration saved.');
      } else {
        setCalibrationIndex((current) => current + 1);
      }
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : 'Calibration could not be saved.');
    }
  };

  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => void fetchState(), 500) as unknown as number;
    void fetchState();
    void fetchConfig();
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  return (
    <div className="fixed right-6 top-20 z-50 w-96 p-4 rounded-lg bg-slate-900/90 border border-white/6 shadow-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <strong>Gesture Control</strong>
        <button onClick={onClose} className="text-xs text-slate-300">Close</button>
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
        {visionError && <div role="alert" className="rounded border border-rose-500/30 bg-rose-950/30 px-2 py-1 text-xs text-rose-300">{visionError}</div>}

        <div className="pt-2">
          <div className="text-xs text-slate-400">Vision State</div>
          <div className="mt-1 p-2 rounded bg-black/40 text-xs">
            <div>status: {state?.status ?? 'unknown'}</div>
            <div>hands_detected: {state?.hands_detected ?? 0}</div>
            <div>fps: {state?.fps ?? '-'}</div>
            <div>latency_ms: {state?.latency_ms ?? '-'}</div>
            <div>gestures: {Array.isArray(state?.gestures) ? state.gestures.map((gesture: any) => gesture.name).join(', ') : '-'}</div>
          </div>
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Gesture Config</div>
          <div className="mt-1 p-2 rounded bg-black/30 text-xs">
            <div>min_confidence: {config?.min_confidence ?? '0.85'}</div>
            <div>frames_required: {config?.frames_required ?? '3'}</div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button onClick={() => void updateConfidence(0.9)} className="px-2 py-1 bg-indigo-600 rounded text-xs">Increase Confidence</button>
            <button onClick={() => void updateConfidence(0.75)} className="px-2 py-1 bg-gray-700 rounded text-xs">Lower Confidence</button>
          </div>
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Mappings</div>
          <button onClick={() => setShowMappingEditor(true)} className="mt-1 px-2 py-1 bg-indigo-600 rounded text-xs">Edit Mappings</button>
        </div>

        <div className="pt-2">
          <div className="text-xs text-slate-400">Calibration</div>
          {!calibrating && <button onClick={startCalibration} className="mt-1 px-2 py-1 bg-indigo-600 rounded text-xs">Start Calibration</button>}
          {calibrating && (
            <div className="mt-1 p-2 rounded bg-black/30 text-xs">
              <div>Step: {calibrationSteps[calibrationIndex]}</div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => void captureCalibrationPoint()} className="px-2 py-1 bg-green-600 rounded text-xs">Capture Point</button>
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
      {showMappingEditor && <div><GestureMappingEditor onClose={() => setShowMappingEditor(false)} /></div>}
    </div>
  );
}
