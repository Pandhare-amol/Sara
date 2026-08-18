import React, { useEffect, useRef, useState } from "react";

export function CameraPanel({ onClose }: { onClose?: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const [status, setStatus] = useState<"off" | "starting" | "active" | "error">("off");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // Listen for voice-driven camera actions dispatched from App
  useEffect(() => {
    const handler = (e: any) => {
      const d = e?.detail || {};
      const act = d.action;
      if (!act) return;
      if (act === 'startCamera') startCamera();
      else if (act === 'stopCamera') stopCamera();
      else if (act === 'takePhoto') {
        const delay = Number(d.delay || 0);
        if (delay > 0) setTimeout(() => takePhoto(), delay * 1000); else takePhoto();
      } else if (act === 'startRecording') {
        const duration = Number(d.duration || 0);
        startRecording();
        if (duration > 0) setTimeout(() => stopRecording(), duration * 1000);
      } else if (act === 'stopRecording') stopRecording();
      else if (act === 'openGallery') fetchAndShowGallery();
    };
    window.addEventListener('sara-camera-action', handler as EventListener);
    return () => window.removeEventListener('sara-camera-action', handler as EventListener);
  }, [selectedDeviceId]);

  const enumerate = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      if (!selectedDeviceId && cams.length > 0) setSelectedDeviceId(cams[0].deviceId);
    } catch (e) {
      console.warn("Failed to enumerate devices", e);
    }
  };

  const startCamera = async () => {
    setErrorText(null);
    setStatus("starting");
    try {
      await enumerate();
      const constraints: MediaStreamConstraints = {
        video: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        try { await videoRef.current.play(); } catch {}
      }
      setStatus("active");

      const track = s.getVideoTracks()[0];
      track.onended = () => {
        stopCamera();
      };
    } catch (e: any) {
      console.error("Camera start failed", e);
      setErrorText(e?.message || String(e));
      setStatus("error");
    }
  };

  const stopCamera = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {}
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      try { (videoRef.current as any).srcObject = null; } catch {}
    }
    setStatus("off");
    setIsRecording(false);
  };

  const takePhoto = async () => {
    if (!streamRef.current || !videoRef.current) return;
    try {
      const video = videoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        setErrorText("Video not ready");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      // POST to server for saving
      const resp = await fetch("/api/camera/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl })
      });
      const j = await resp.json();
      if (!resp.ok) {
        setErrorText(j?.error || "Failed to save photo");
      } else {
        // success
      }
    } catch (e: any) {
      setErrorText(e?.message || String(e));
    }
  };

  const startRecording = async () => {
    if (!streamRef.current) {
      await startCamera();
      if (!streamRef.current) return;
    }
    try {
      recordedChunksRef.current = [];
      const mime = "video/webm;codecs=vp8";
      const rec = new MediaRecorder(streamRef.current as MediaStream, { mimeType: mime });
      recorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        try {
          const resp = await fetch("/api/camera/video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataBase64: base64 })
          });
          const j = await resp.json();
          if (!resp.ok) setErrorText(j?.error || "Failed to save video");
        } catch (e: any) {
          setErrorText(e?.message || String(e));
        }
        setIsRecording(false);
      };
      rec.start(1000);
      setIsRecording(true);
    } catch (e: any) {
      setErrorText(e?.message || String(e));
    }
  };

  const stopRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch (e) {
      console.warn("Stop recording failed", e);
    }
  };

  const listGallery = async () => {
    try {
      const r = await fetch('/api/camera/gallery');
      if (!r.ok) return [];
      const j = await r.json();
      return j;
    } catch (e) { return []; }
  };

  const [showGallery, setShowGallery] = useState(false);
  const [gallery, setGallery] = useState<{ photos: any[]; videos: any[] }>({ photos: [], videos: [] });
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionState, setVisionState] = useState<any>(null);
  const visionIntervalRef = useRef<number | null>(null);

  const fetchAndShowGallery = async () => {
    const g = await listGallery();
    setGallery(g);
    setShowGallery(true);
  };

  const deleteMedia = async (type: 'photo' | 'video', filename: string) => {
    try {
      const r = await fetch('/api/camera/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, filename }) });
      const j = await r.json();
      if (!r.ok) setErrorText(j?.error || 'Delete failed');
      else fetchAndShowGallery();
    } catch (e: any) { setErrorText(e?.message || String(e)); }
  };

  const openContainingFolder = async (type: 'photo' | 'video', filename: string) => {
    try {
      await fetch('/api/camera/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, filename }) });
    } catch (e) { console.warn('Open folder request failed', e); }
  };

  // Vision polling and overlay
  useEffect(() => {
    const visionHandler = (e: any) => {
      const d = e?.detail || {};
      if (d.action === 'enable') {
        fetch('/api/vision/enable', { method: 'POST' }).then(() => setVisionEnabled(true)).catch(() => {});
      } else if (d.action === 'disable') {
        fetch('/api/vision/disable', { method: 'POST' }).then(() => setVisionEnabled(false)).catch(() => {});
      }
    };
    window.addEventListener('sara-vision-action', visionHandler as EventListener);
    return () => window.removeEventListener('sara-vision-action', visionHandler as EventListener);
  }, []);

  useEffect(() => {
    if (visionEnabled) {
      // poll vision state
      visionIntervalRef.current = window.setInterval(async () => {
        try {
          const r = await fetch('/api/vision/state');
          if (!r.ok) return;
          const j = await r.json();
          setVisionState(j);
        } catch (e) { /* ignore */ }
      }, 250) as unknown as number;
    } else {
      if (visionIntervalRef.current) { clearInterval(visionIntervalRef.current); visionIntervalRef.current = null; }
      setVisionState(null);
    }
    return () => { if (visionIntervalRef.current) { clearInterval(visionIntervalRef.current); visionIntervalRef.current = null; } };
  }, [visionEnabled]);

  return (
    <div className="absolute z-40 right-6 top-20 w-96 p-4 rounded-2xl bg-slate-900/90 border border-white/6 backdrop-blur-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-bold">Camera</div>
        <div className="text-xs text-slate-400">Status: {status}</div>
      </div>

      <div className="aspect-video w-full rounded-md overflow-hidden bg-black mb-3">
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted />
          {visionState && visionState.hands && Array.isArray(visionState.hands) && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {visionState.hands.map((h: any, idx: number) => {
                const x = (h.cx ?? h.x ?? 0);
                const y = (h.cy ?? h.y ?? 0);
                // assume normalized coords [0..1]
                const style: React.CSSProperties = {
                  position: 'absolute',
                  left: `${(x * 100).toFixed(2)}%`,
                  top: `${(y * 100).toFixed(2)}%`,
                  transform: 'translate(-50%, -50%)',
                };
                return (
                  <div key={idx} style={style}>
                    <div style={{ width: 14, height: 14, borderRadius: 8, background: 'rgba(34,197,94,0.9)', border: '2px solid white' }} />
                    {h.label && <div style={{ marginTop: 4, fontSize: 10, textAlign: 'center' }}>{h.label}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {visionState && Array.isArray(visionState.gestures) && visionState.gestures.length > 0 && (
        <div className="mt-2 p-2 rounded-md bg-indigo-900/40 border border-indigo-500/20 text-xs">
          <div className="font-bold text-[11px]">Gestures</div>
          <div className="text-[12px]">
            {visionState.gestures.map((g: any, i: number) => (
              <div key={i}>{g.name} — {Math.round((g.confidence||0)*100)}%</div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        {status !== "active" && <button onClick={startCamera} className="px-3 py-1 bg-green-600 rounded text-xs">Start Camera</button>}
        {status === "active" && <button onClick={stopCamera} className="px-3 py-1 bg-red-700 rounded text-xs">Stop Camera</button>}
        <button onClick={takePhoto} className="px-3 py-1 bg-indigo-600 rounded text-xs">Take Photo</button>
        {!isRecording && <button onClick={startRecording} className="px-3 py-1 bg-amber-600 rounded text-xs">Start Recording</button>}
        {isRecording && <button onClick={stopRecording} className="px-3 py-1 bg-rose-600 rounded text-xs">Stop Recording</button>}
      </div>

      {errorText && <div className="text-xs text-rose-300">{errorText}</div>}

      <div className="mt-3 text-xs text-slate-400">Devices</div>
      <div className="flex gap-2 mt-2">
        <select value={selectedDeviceId ?? ""} onChange={(e) => setSelectedDeviceId(e.target.value)} className="flex-1 bg-slate-800 p-1 rounded text-xs">
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
        </select>
        <button onClick={enumerate} className="px-2 py-1 bg-slate-700 rounded text-xs">Refresh</button>
      </div>

      <div className="mt-3 flex justify-end">
        <button onClick={() => { stopCamera(); onClose?.(); }} className="px-3 py-1 bg-white/5 rounded text-xs">Close</button>
      </div>
      <div className="mt-4">
        <button onClick={() => { fetchAndShowGallery(); }} className="px-3 py-1 bg-slate-700 rounded text-xs">Open Gallery</button>
        <button onClick={async () => {
          // toggle gesture control via server vision endpoints
          try {
            const r = await fetch('/api/vision/enable', { method: 'POST' });
            if (!r.ok) setErrorText('Failed to enable vision');
            else setErrorText(null);
          } catch (e) { setErrorText('Vision enable failed'); }
        }} className="ml-2 px-3 py-1 bg-indigo-600 rounded text-xs">Enable Gesture Control</button>
        <button onClick={async () => {
          try { await fetch('/api/vision/disable', { method: 'POST' }); } catch {}
        }} className="ml-2 px-3 py-1 bg-rose-600 rounded text-xs">Disable Gesture Control</button>
        <button onClick={async () => { try { await fetch('/api/orchestrator/emergency-stop', { method: 'POST' }); } catch {} }} className="ml-2 px-3 py-1 bg-red-700 rounded text-xs">Emergency Stop</button>
      </div>

      {showGallery && (
        <div className="mt-3 max-h-56 overflow-auto bg-slate-950/60 p-2 rounded">
          <div className="text-xs font-bold mb-2">Photos</div>
          <div className="grid grid-cols-2 gap-2">
            {gallery.photos.map((p: any) => (
              <div key={p.filename} className="bg-black/20 p-1 rounded">
                <img src={`/api/camera/photo/${encodeURIComponent(p.filename)}`} className="w-full h-28 object-cover rounded" />
                <div className="flex justify-between mt-1 text-xs">
                  <button onClick={() => openContainingFolder('photo', p.filename)} className="text-slate-300">Open Folder</button>
                  <button onClick={() => deleteMedia('photo', p.filename)} className="text-rose-300">Delete</button>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs font-bold my-2">Videos</div>
          <div className="grid grid-cols-1 gap-2">
            {gallery.videos.map((v: any) => (
              <div key={v.filename} className="bg-black/20 p-1 rounded">
                <video src={`/api/camera/video/${encodeURIComponent(v.filename)}`} className="w-full h-36 object-cover rounded" controls />
                <div className="flex justify-between mt-1 text-xs">
                  <button onClick={() => openContainingFolder('video', v.filename)} className="text-slate-300">Open Folder</button>
                  <button onClick={() => deleteMedia('video', v.filename)} className="text-rose-300">Delete</button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-right"><button onClick={() => setShowGallery(false)} className="text-xs px-2 py-1 bg-white/5 rounded">Close Gallery</button></div>
        </div>
      )}
    </div>
  );
}

export default CameraPanel;
