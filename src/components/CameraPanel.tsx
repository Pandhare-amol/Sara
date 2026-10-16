import React, { useCallback, useEffect, useRef, useState } from "react";
import { CameraManager, FrameRateController, VisionSession } from "../vision";

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode camera frame.")), type, quality);
  });
}

export function CameraPanel({ onClose }: { onClose?: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingSavedRef = useRef<Promise<{ ok: boolean; path?: string; filename?: string; error?: string }> | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const cameraManagerRef = useRef(new CameraManager());
  const frameRateControllerRef = useRef(new FrameRateController(500));
  const visionSessionRef = useRef<VisionSession | null>(null);

  const [status, setStatus] = useState<"off" | "starting" | "active" | "error">("off");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisText, setAnalysisText] = useState<string | null>(null);

  const updateVisionEnabled = useCallback(async (enabled: boolean) => {
    try {
      const response = await fetch(`/api/vision/${enabled ? "enable" : "disable"}`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok === false) {
        throw new Error(result?.error || `Failed to ${enabled ? "enable" : "disable"} vision.`);
      }
      setVisionEnabled(enabled);
      setErrorText(null);
    } catch (error: any) {
      setErrorText(error?.message || `Failed to ${enabled ? "enable" : "disable"} vision.`);
    }
  }, []);

  useEffect(() => {
    cameraManagerRef.current.onStatusChange = (snapshot) => {
      if (snapshot.status === "CAMERA_DISCONNECTED") {
        setStatus("error");
        setErrorText(snapshot.error || "The camera was disconnected.");
        streamRef.current = null;
      }
    };
    return () => {
      cameraManagerRef.current.onStatusChange = undefined;
      stopCamera();
    };
  }, []);

  // Result-bearing camera actions originate from the active voice tool call.
  // A command is *not* complete when the event is dispatched; only this
  // handler's actual browser/media/HTTP outcome is returned to the model.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const respond = typeof detail.respond === "function" ? detail.respond as (value: unknown) => void : () => {};
      void (async () => {
        const action = String(detail.action || "");
        if (action === "start" || action === "startCamera") return startCamera();
        if (action === "stop" || action === "stopCamera") return stopCamera();
        if (action === "status") return { ok: true, status: streamRef.current ? "active" : "off",
          streamActive: Boolean(streamRef.current?.getVideoTracks().some((track) => track.readyState === "live")),
          recording: recorderRef.current?.state === "recording" };
        if (action === "photo" || action === "takePhoto") return takePhoto();
        if (action === "analyze" || action === "analyzeVision") return analyzeFrame(detail.question);
        if (action === "record_start" || action === "startRecording") {
          const duration = Number(detail.duration || 0);
          if (!Number.isFinite(duration) || duration < 0 || duration > 20) {
            return { ok: false, error: "Recording duration must be 0–20 seconds. Longer capture requires a separate explicit stop request." };
          }
          const started = await startRecording();
          if (!started.ok) return started;
          if (duration > 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, duration * 1000));
            return { ...await stopRecording(), saved: true };
          }
          return started;
        }
        if (action === "record_stop" || action === "stopRecording") return stopRecording();
        if (action === "openGallery") { await fetchAndShowGallery(); return { ok: true, status: "gallery_opened" }; }
        return { ok: false, error: "Unsupported camera action." };
      })().then(respond, (error) => respond({ ok: false, error: error?.message || "Camera action failed." }));
    };
    window.addEventListener("sara-camera-action", handler);
    return () => window.removeEventListener("sara-camera-action", handler);
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

  const startCamera = async (): Promise<{ ok: boolean; status?: string; streamActive?: boolean; error?: string }> => {
    if (streamRef.current?.getVideoTracks().some((track) => track.readyState === "live")) {
      return { ok: true, status: "active", streamActive: true };
    }
    setErrorText(null);
    setStatus("starting");
    try {
      await enumerate();
      const s = await cameraManagerRef.current.start(selectedDeviceId ?? undefined);
      visionSessionRef.current = new VisionSession();
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        try { await videoRef.current.play(); } catch {}
      }
      const streamActive = s.getVideoTracks().some((track) => track.readyState === "live");
      if (!streamActive) throw new Error("Camera stream has no active video track.");
      setStatus("active");
      return { ok: true, status: "active", streamActive: true };
    } catch (e: any) {
      console.error("Camera start failed", e);
      const error = e?.message || String(e);
      setErrorText(error);
      setStatus("error");
      return { ok: false, error };
    }
  };

  const stopCamera = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {}
    cameraManagerRef.current.stop();
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      try { (videoRef.current as any).srcObject = null; } catch {}
    }
    setStatus("off");
    setIsRecording(false);
    visionSessionRef.current?.end();
    visionSessionRef.current = null;
    return { ok: true, status: "off", streamActive: false };
  };

  const takePhoto = async (): Promise<{ ok: boolean; path?: string; filename?: string; error?: string }> => {
    if (!streamRef.current) {
      const started = await startCamera();
      if (!started.ok) return { ok: false, error: started.error || "Camera permission was not granted." };
    }
    if (!videoRef.current) return { ok: false, error: "Camera preview is not mounted." };
    try {
      const video = videoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        await Promise.race([new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true })),
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000))]);
      }
      if (!video.videoWidth || !video.videoHeight) {
        setErrorText("Camera video is not ready.");
        return { ok: false, error: "Camera video is not ready." };
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, error: "Camera canvas is unavailable." };
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const resp = await fetch("/api/camera/photo", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: image
      });
      const j = await resp.json();
      if (!resp.ok || !j?.ok || !j?.path || !j?.filename) {
        const error = j?.error || "Failed to save photo";
        setErrorText(error);
        return { ok: false, error };
      }
      return { ok: true, path: j.path, filename: j.filename };
    } catch (e: any) {
      const error = e?.message || String(e);
      setErrorText(error);
      return { ok: false, error };
    }
  };

  const analyzeFrame = async (question?: string): Promise<{ ok: boolean; text?: string; error?: string }> => {
    if (!streamRef.current) {
      const started = await startCamera();
      if (!started.ok) return { ok: false, error: started.error || "Camera permission was not granted." };
    }
    if (!videoRef.current || videoRef.current.videoWidth === 0) {
      setErrorText("Start the camera and wait for the preview before analyzing.");
      return { ok: false, error: "The camera has not produced a visible frame yet. Please retry." };
    }
    setIsAnalyzing(true);
    setAnalysisText(null);
    try {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Camera frame is unavailable.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!frameRateControllerRef.current.shouldCapture()) return { ok: false, error: "Please wait for a new camera frame." };
      visionSessionRef.current?.recordFrame();
      visionSessionRef.current?.beginAnalysis();
      const startedAt = performance.now();
      const image = await canvasToBlob(canvas, "image/jpeg", 0.8);
      const response = await fetch("/api/vision/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-SARA-Question": `${typeof question === "string" ? question.slice(0, 350) : "Describe what is visible."} Describe only visible, non-sensitive details; do not infer emotions, personality, health, or identity.`,
        },
        body: image,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Vision analysis failed.");
      const description = String(result.text || "").trim();
      if (!description) throw new Error("The provider did not return a usable camera description.");
      setAnalysisText(description);
      visionSessionRef.current?.finishAnalysis(description, performance.now() - startedAt);
      return { ok: true, text: description };
    } catch (error: any) {
      const message = error?.message || String(error);
      setErrorText(message);
      return { ok: false, error: message };
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startRecording = async (): Promise<{ ok: boolean; status?: string; streamActive?: boolean; recording?: boolean; error?: string }> => {
    if (recorderRef.current?.state === "recording") return { ok: false, error: "A video is already recording." };
    if (!streamRef.current) {
      const started = await startCamera();
      if (!started.ok) return { ok: false, error: started.error || "Camera permission was not granted." };
    }
    try {
      if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
        throw new Error("This browser does not support saving WebM video.");
      }
      recordedChunksRef.current = [];
      const rec = new MediaRecorder(streamRef.current as MediaStream, { mimeType: "video/webm;codecs=vp8" });
      let finish!: (result: { ok: boolean; path?: string; filename?: string; error?: string }) => void;
      recordingSavedRef.current = new Promise((resolve) => { finish = resolve; });
      recorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      rec.onerror = () => {
        const error = "Video recording failed before it could be saved.";
        setErrorText(error);
        finish({ ok: false, error });
        setIsRecording(false);
      };
      rec.onstop = async () => {
        try {
          const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
          if (!blob.size) throw new Error("The recording is empty.");
          if (blob.size > 50 * 1024 * 1024) throw new Error("The recording exceeds the 50 MB upload limit.");
          const resp = await fetch("/api/camera/video", {
            method: "POST", headers: { "Content-Type": "video/webm" }, body: blob,
          });
          const saved = await resp.json();
          if (!resp.ok || !saved?.ok || !saved.path || !saved.filename) throw new Error(saved?.error || "Failed to save video.");
          finish({ ok: true, path: saved.path, filename: saved.filename });
        } catch (error: any) {
          const message = error?.message || String(error);
          setErrorText(message);
          finish({ ok: false, error: message });
        } finally {
          setIsRecording(false);
        }
      };
      rec.start(1000);
      if (rec.state !== "recording") throw new Error("The browser did not start recording.");
      setIsRecording(true);
      return { ok: true, status: "recording", streamActive: true, recording: true };
    } catch (error: any) {
      const message = error?.message || String(error);
      setErrorText(message);
      setIsRecording(false);
      return { ok: false, error: message };
    }
  };

  const stopRecording = async (): Promise<{ ok: boolean; path?: string; filename?: string; error?: string }> => {
    const recorder = recorderRef.current;
    const saving = recordingSavedRef.current;
    if (!recorder || !saving) return { ok: false, error: "No active video recording was found." };
    try {
      if (recorder.state !== "inactive") recorder.stop();
      // A stop request is not a saved video until MediaRecorder fires onstop,
      // the upload succeeds, and the server confirms the file path.
      return await saving;
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    } finally {
      recordingSavedRef.current = null;
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
        void updateVisionEnabled(true);
      } else if (d.action === 'disable') {
        void updateVisionEnabled(false);
      }
    };
    window.addEventListener('sara-vision-action', visionHandler as EventListener);
    return () => window.removeEventListener('sara-vision-action', visionHandler as EventListener);
  }, [updateVisionEnabled]);

  useEffect(() => {
    if (visionEnabled) {
      // poll vision state
      visionIntervalRef.current = window.setInterval(async () => {
        try {
          const r = await fetch('/api/vision/state');
          if (!r.ok) return;
          const j = await r.json();
          if (j?.ok === false) return;
          setVisionState(j?.result || j);
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
        <button onClick={analyzeFrame} disabled={isAnalyzing} className="px-3 py-1 bg-cyan-600 rounded text-xs">{isAnalyzing ? "Analyzing..." : "Analyze Vision"}</button>
      </div>

      <div className="mb-2 text-xs font-semibold text-cyan-200">
        CAMERA: {status === "active" ? "ON" : "OFF"} · VISION: {isAnalyzing || analysisText ? "ACTIVE" : "INACTIVE"}
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
        Analyze sends one still frame to Gemini. SARA does not continuously scan or infer your emotions from your face. Stop Camera to end the stream.
      </p>
      {analysisText && <div className="mb-2 rounded bg-cyan-950/50 p-2 text-xs text-cyan-100">{analysisText}</div>}

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
        <button onClick={() => void updateVisionEnabled(true)} className="ml-2 px-3 py-1 bg-indigo-600 rounded text-xs">Enable Gesture Control</button>
        <button onClick={() => void updateVisionEnabled(false)} className="ml-2 px-3 py-1 bg-rose-600 rounded text-xs">Disable Gesture Control</button>
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
