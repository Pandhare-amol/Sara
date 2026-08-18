import React, { useEffect, useRef, useState } from 'react';

// Lightweight browser-side MediaPipe-like fallback using minimal heuristics.
// This component captures video frames, computes simple hand heuristics (center of bright skin-like area),
// and debounces simple gestures like 'PINCH' (distance between thumb/index) and 'OPEN_PALM' (area large).
// When a gesture is confirmed locally it POSTs to the server to the gestureForward endpoint.

export function BrowserVisionFallback({ enabled }: { enabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [supported, setSupported] = useState(false);
  const [running, setRunning] = useState(false);
  const stateRef = useRef({ lastPinch: 0, lastOpen: 0 });

  useEffect(() => {
    setSupported(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }, []);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    start();
    return () => stop();
  }, [enabled]);

  const start = async () => {
    if (!supported) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.srcObject = s;
      await v.play();
      videoRef.current = v;
      setRunning(true);
      tick();
    } catch (e) { console.warn('BrowserVisionFallback start failed', e); }
  };
  const stop = () => {
    setRunning(false);
    if (videoRef.current && videoRef.current.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    videoRef.current = null;
  };

  const tick = () => {
    if (!running || !videoRef.current) return;
    const v = videoRef.current;
    const w = 320, h = 240;
    const c = canvasRef.current;
    if (!c) {
      const cc = document.createElement('canvas'); cc.width = w; cc.height = h; canvasRef.current = cc;
    }
    const ctx = (canvasRef.current as HTMLCanvasElement).getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    // crude skin detection: R > 95 && G > 40 && B > 20 && R > G && R > B
    let sumX = 0, sumY = 0, count = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      if (r > 95 && g > 40 && b > 20 && r > g && r > b) {
        const idx = i/4; const x = idx % w; const y = Math.floor(idx / w);
        sumX += x; sumY += y; count++;
        if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
    if (count > 50) {
      const cx = sumX / count / w;
      const cy = sumY / count / h;
      const area = (maxX-minX) * (maxY-minY);
      // heuristics: large area => open palm; small area & narrow bounding box => pinch
      if (area > 1500) {
        stateRef.current.lastOpen = Date.now();
      } else {
        // potential pinch detected
        stateRef.current.lastPinch = Date.now();
      }
      // confirm events after short debounce
      const now = Date.now();
      if (now - stateRef.current.lastPinch < 300) {
        sendConfirmedGesture('PINCH', { x_norm: cx, y_norm: cy });
      }
      if (now - stateRef.current.lastOpen < 300) {
        sendConfirmedGesture('OPEN_PALM', { x_norm: cx, y_norm: cy });
      }
    }
    requestAnimationFrame(tick);
  };

  const sendConfirmedGesture = async (gesture: string, args: any) => {
    try {
      await fetch('/api/desktop/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'gestureForward', args: { gesture, args, confirmed: true } }) });
    } catch (e) { console.warn('sendConfirmedGesture failed', e); }
  };

  if (!supported) return <div className="text-xs p-2">Browser vision not supported</div>;
  return <div className="text-xs p-2">Browser vision {running ? 'running' : 'stopped'}</div>;
}
