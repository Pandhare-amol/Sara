import React, { useEffect, useRef, useState } from 'react';

// Lightweight browser-side gesture preview using simple heuristics. It never
// dispatches desktop input: gesture forwarding is not implemented by the active agent.
export function BrowserVisionFallback({ enabled }: { enabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runningRef = useRef(false);
  const [supported, setSupported] = useState(false);
  const [running, setRunning] = useState(false);
  const [detectedGesture, setDetectedGesture] = useState('none');

  useEffect(() => {
    setSupported(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }, []);

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setDetectedGesture('none');
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    videoRef.current = null;
  };

  const tick = () => {
    if (!runningRef.current || !videoRef.current) return;
    const video = videoRef.current;
    const width = 320;
    const height = 240;
    if (!canvasRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvasRef.current = canvas;
    }
    const context = canvasRef.current.getContext('2d');
    if (!context) return;
    try {
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      for (let index = 0; index < image.data.length; index += 4) {
        const red = image.data[index];
        const green = image.data[index + 1];
        const blue = image.data[index + 2];
        if (red > 95 && green > 40 && blue > 20 && red > green && red > blue) {
          const pixel = index / 4;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          count += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      const area = (maxX - minX) * (maxY - minY);
      const nextGesture = count > 50 ? area > 1500 ? 'OPEN_PALM' : 'PINCH' : 'none';
      setDetectedGesture((current) => current === nextGesture ? current : nextGesture);
    } catch (error) {
      console.warn('Browser gesture preview frame failed', error);
    }
    if (runningRef.current) requestAnimationFrame(tick);
  };

  const start = async () => {
    if (!supported || runningRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      videoRef.current = video;
      runningRef.current = true;
      setRunning(true);
      requestAnimationFrame(tick);
    } catch (error) {
      console.warn('BrowserVisionFallback start failed', error);
      stop();
    }
  };

  useEffect(() => {
    if (enabled) void start();
    else stop();
    return () => stop();
  }, [enabled, supported]);

  if (!supported) return <div className="text-xs p-2">Browser vision not supported</div>;
  return (
    <div className="text-xs p-2">
      Gesture preview {running ? 'running' : 'stopped'} · detected: {detectedGesture} · no desktop actions are dispatched.
    </div>
  );
}
