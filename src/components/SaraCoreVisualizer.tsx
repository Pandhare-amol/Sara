import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import type { SaraAudioSession, LiveState } from "../lib/audio";
const SaraAvatar3D = lazy(() => import("./SaraAvatar3D").then((module) => ({ default: module.SaraAvatar3D })));
import {
  resolveAvatarPresentation,
  type AvatarExpression,
  type AvatarExpressionChoice,
  type AvatarGesture,
  type AvatarGestureChoice,
  type SaraEmotion,
} from "../avatar/avatarState";

export type { SaraEmotion } from "../avatar/avatarState";

interface SaraCoreVisualizerProps {
  session: SaraAudioSession | null;
  state: LiveState;
  themeColor: string;
  activeEmotion?: SaraEmotion;
  characterState: "idle" | "thinking" | "talking";
}

type VisualizerMode = "3d" | "video";

const expressionOptions: Array<{ value: AvatarExpression; label: string }> = [
  { value: "neutral", label: "Neutral" },
  { value: "smile", label: "Smile" },
  { value: "happy", label: "Happy" },
  { value: "laugh", label: "Laugh" },
  { value: "curious", label: "Curious" },
  { value: "thinking", label: "Thinking" },
  { value: "surprised", label: "Surprised" },
  { value: "concerned", label: "Concerned" },
  { value: "confused", label: "Confused" },
  { value: "reassuring", label: "Reassuring" },
  { value: "listening", label: "Listening" },
  { value: "sleepy", label: "Sleepy" },
  { value: "greeting", label: "Greeting" },
];

const gestureOptions: Array<{ value: AvatarGesture; label: string }> = [
  { value: "rest", label: "Rest" },
  { value: "wave", label: "Wave" },
  { value: "explain", label: "Explain" },
  { value: "point", label: "Point" },
  { value: "think", label: "Think" },
  { value: "listen", label: "Listen" },
  { value: "celebrate", label: "Celebrate" },
  { value: "nod", label: "Nod" },
];

export const SaraCoreVisualizer: React.FC<SaraCoreVisualizerProps> = ({
  session,
  state,
  themeColor,
  activeEmotion = "idle",
  characterState,
}) => {
  const animationRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const idleVideoRef = useRef<HTMLVideoElement | null>(null);
  const thinkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const talkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<VisualizerMode>("3d");
  const [expressionChoice, setExpressionChoice] = useState<AvatarExpressionChoice>("auto");
  const [gestureChoice, setGestureChoice] = useState<AvatarGestureChoice>("auto");
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [resetCameraToken, setResetCameraToken] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  const targetMouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  const speechVolumeRef = useRef<number>(0);
  const particlesRef = useRef<Array<{ x: number; y: number; speed: number; size: number; opacity: number }>>([]);

  const presentation = resolveAvatarPresentation(state, characterState, activeEmotion as SaraEmotion, expressionChoice, gestureChoice);

  useEffect(() => {
    if (mode !== "video") return;
    const selectedVideo = presentation.state === "speaking"
      ? talkingVideoRef.current
      : presentation.state === "thinking"
        ? thinkingVideoRef.current
        : idleVideoRef.current;
    const videos = [idleVideoRef.current, thinkingVideoRef.current, talkingVideoRef.current];
    videos.forEach((video) => {
      if (!video) return;
      if (video === selectedVideo) {
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    });
  }, [mode, presentation.state]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      targetMouseRef.current = { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight };
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Keep the existing lightweight ambient particles; only the character rendering is switched to real 3D.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = canvas.width = canvas.offsetWidth;
    let height = canvas.height = canvas.offsetHeight;
    const resize = () => {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      const count = Math.min(60, Math.floor(width / 24));
      particlesRef.current = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        speed: Math.random() * 0.32 + 0.12,
        size: Math.random() * 1.4 + 0.5,
        opacity: Math.random() * 0.48 + 0.12,
      }));
    };
    resize();
    window.addEventListener("resize", resize);

    const getColor = () => {
      switch (themeColor) {
        case "violet": return "147,51,234";
        case "crimson": return "225,29,72";
        case "emerald": return "5,150,105";
        case "celestial": return "2,132,199";
        case "gold": return "202,138,4";
        case "rose": return "219,39,119";
        default: return "34,211,238";
      }
    };
    const color = getColor();
    let audioData: Uint8Array<ArrayBuffer> | null = null;
    const render = () => {
      ctx.clearRect(0, 0, width, height);
      const activeAnalyser = state === "speaking" ? session?.outputAnalyser : state === "listening" ? session?.inputAnalyser : null;
      let audioLevel = 0;
      if (activeAnalyser) {
        if (!audioData || audioData.length !== activeAnalyser.frequencyBinCount) {
          audioData = new Uint8Array(new ArrayBuffer(activeAnalyser.frequencyBinCount));
        }
        try {
          activeAnalyser.getByteFrequencyData(audioData);
          let sum = 0;
          for (let index = 0; index < audioData.length; index += 1) sum += audioData[index];
          audioLevel = sum / Math.max(1, audioData.length) / 255;
        } catch { audioLevel = 0; }
      }
      speechVolumeRef.current += (audioLevel - speechVolumeRef.current) * 0.18;
      mouseRef.current.x += (targetMouseRef.current.x - mouseRef.current.x) * 0.05;
      mouseRef.current.y += (targetMouseRef.current.y - mouseRef.current.y) * 0.05;
      const scale = Math.max(0.85, Math.min(1.55, height / 560));

      const glow = ctx.createRadialGradient(width / 2, height * 0.56, 0, width / 2, height * 0.56, Math.max(width, height) * 0.56);
      glow.addColorStop(0, `rgba(${color},${0.035 + speechVolumeRef.current * 0.05})`);
      glow.addColorStop(0.55, `rgba(${color},0.012)`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      particlesRef.current.forEach((particle) => {
        particle.y -= particle.speed * (1 + speechVolumeRef.current * 1.5);
        particle.x += Math.sin(particle.y * 0.015 + particle.size + mouseRef.current.x) * 0.24;
        if (particle.y < height * 0.10) {
          particle.y = height + Math.random() * 24;
          particle.x = Math.random() * width;
        }
        const alpha = particle.opacity * Math.max(0, particle.y / Math.max(1, height)) * 0.55;
        ctx.fillStyle = `rgba(${color},${alpha})`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * scale, 0, Math.PI * 2);
        ctx.fill();
      });
      animationRef.current = window.requestAnimationFrame(render);
    };
    animationRef.current = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      if (animationRef.current !== null) window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [session, state, themeColor]);

  const handleVideoError = (videoName: string) => {
    console.warn(`[SARA video fallback] Failed to load ${videoName}.mp4.`);
    setVideoError(`Could not load ${videoName}.mp4. The existing videos remain an optional fallback, not the 3D avatar.`);
  };

  const selectClass = "rounded-lg border border-white/15 bg-slate-950/85 px-2 py-1.5 text-[10px] font-medium text-slate-100 outline-none transition focus:border-cyan-300/60 focus:ring-1 focus:ring-cyan-300/30";

  return (
    <div className="pointer-events-none relative flex h-full min-h-[360px] w-full items-center justify-center overflow-hidden">
      <div className={`pointer-events-none absolute inset-0 z-0 bg-gradient-to-b ${
        themeColor === "violet" ? "from-violet-950/10 via-transparent to-fuchsia-950/15" :
        themeColor === "crimson" ? "from-rose-950/10 via-transparent to-orange-950/15" :
        themeColor === "emerald" ? "from-emerald-950/10 via-transparent to-teal-950/15" :
        themeColor === "celestial" ? "from-sky-950/10 via-transparent to-cyan-950/15" :
        themeColor === "gold" ? "from-amber-950/10 via-transparent to-yellow-950/15" :
        themeColor === "rose" ? "from-rose-950/10 via-transparent to-pink-950/15" :
        "from-indigo-950/10 via-transparent to-cyan-950/15"
      }`} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-1/3 bg-gradient-to-t from-black/35 to-transparent" />

      <div id="sara-animated-presence" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        {mode === "3d" ? (
          <div className="pointer-events-auto relative h-full max-h-[88vh] w-full max-w-[920px] overflow-hidden">
            <Suspense fallback={<div role="status" className="absolute inset-0 flex items-center justify-center text-xs text-cyan-100/70">Preparing the procedural 3D companion…</div>}>
              <SaraAvatar3D
                presentation={presentation}
                outputAnalyser={session?.outputAnalyser ?? null}
                resetCameraToken={resetCameraToken}
                onRendererError={setRendererError}
              />
            </Suspense>
            {rendererError && (
              <div role="alert" className="pointer-events-auto absolute inset-x-4 bottom-16 mx-auto max-w-sm rounded-xl border border-amber-300/25 bg-slate-950/90 p-3 text-center text-xs text-amber-100 shadow-2xl backdrop-blur">
                {rendererError} Use “Existing video fallback” above to view the legacy clips.
              </div>
            )}
          </div>
        ) : (
          <div className="pointer-events-auto relative flex h-full max-h-[72vh] w-full max-w-4xl items-center justify-center px-5">
            <div className="pointer-events-none absolute inset-8 rounded-[2.5rem] bg-cyan-500/10 blur-[55px]" />
            <video ref={idleVideoRef} src="/assets/idle.mp4" loop muted playsInline className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-500 ${presentation.state === "idle" || presentation.state === "listening" ? "opacity-100" : "opacity-0"}`} onError={() => handleVideoError("idle")} />
            <video ref={thinkingVideoRef} src="/assets/thinking.mp4" loop muted playsInline className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-500 ${presentation.state === "thinking" ? "opacity-100" : "opacity-0"}`} onError={() => handleVideoError("thinking")} />
            <video ref={talkingVideoRef} src="/assets/talking.mp4" loop muted playsInline className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-500 ${presentation.state === "speaking" ? "opacity-100" : "opacity-0"}`} onError={() => handleVideoError("talking")} />
            {videoError && (
              <div role="status" className="pointer-events-auto absolute inset-x-4 bottom-16 mx-auto max-w-sm rounded-xl border border-slate-300/15 bg-slate-950/90 p-3 text-center text-xs text-slate-300 shadow-xl backdrop-blur">
                {videoError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-30 flex items-start gap-2 sm:left-6 sm:top-6">
        <div className="pointer-events-none flex items-center gap-2 rounded-xl border border-cyan-200/15 bg-slate-950/60 px-3 py-2 shadow-lg shadow-cyan-950/20 backdrop-blur-md">
          <Sparkles className="text-cyan-200" size={15} aria-hidden="true" />
          <div className="leading-tight">
            <div className="text-[10px] font-semibold tracking-[0.16em] text-cyan-50">SARA · {mode === "3d" ? "3D COMPANION" : "VIDEO FALLBACK"}</div>
            <div className="mt-1 text-[8px] font-mono tracking-wide text-slate-400">
              {presentation.state.toUpperCase()} · {presentation.expression.toUpperCase()} · {presentation.gesture.toUpperCase()}
            </div>
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-white/10 bg-slate-950/65 p-1.5 shadow-lg backdrop-blur-md">
          <button type="button" onClick={() => { setMode(mode === "3d" ? "video" : "3d"); setVideoError(null); }} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[9px] font-semibold tracking-wide text-slate-100 transition hover:border-cyan-200/40 hover:bg-cyan-300/10" aria-label={mode === "3d" ? "Switch to existing video fallback" : "Switch to interactive 3D companion"}>
            {mode === "3d" ? "Existing video fallback" : "Interactive 3D"}
          </button>
        </div>
      </div>

      {mode === "3d" && (
        <div className="pointer-events-auto absolute bottom-4 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/72 p-2 shadow-xl shadow-black/25 backdrop-blur-xl sm:bottom-6 sm:left-6 sm:max-w-none">
          <button type="button" onClick={() => setShowControls((visible) => !visible)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[9px] font-semibold text-slate-200 hover:border-cyan-200/35" aria-expanded={showControls}>
            {showControls ? "Hide controls" : "Avatar controls"}
          </button>
          {showControls && <>
            <label className="flex items-center gap-1.5 text-[9px] text-slate-300">
              Expression
              <select aria-label="SARA expression" className={selectClass} value={expressionChoice} onChange={(event) => setExpressionChoice(event.target.value as AvatarExpressionChoice)}>
                <option value="auto">Auto</option>
                {expressionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[9px] text-slate-300">
              Gesture
              <select aria-label="SARA gesture" className={selectClass} value={gestureChoice} onChange={(event) => setGestureChoice(event.target.value as AvatarGestureChoice)}>
                <option value="auto">Auto</option>
                {gestureOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => setResetCameraToken((token) => token + 1)} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[9px] text-slate-200 transition hover:border-cyan-200/35" aria-label="Reset 3D camera">
              <RotateCcw size={12} /> Reset view
            </button>
            <span className="hidden text-[8px] text-slate-500 lg:inline">Drag to rotate · scroll/pinch to zoom</span>
          </>}
        </div>
      )}

      <div
        className="pointer-events-none absolute right-3 top-14 z-30 flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-slate-950/55 px-2.5 py-2 shadow-lg shadow-cyan-950/20 backdrop-blur-md sm:right-6 sm:top-16"
        aria-label="SARA: fictional adult AI persona, age 20"
        title="SARA — fictional adult AI persona, age 20"
      >
        <img
          src="/assets/sara-persona-avatar.png"
          alt="Fictional portrait of SARA, an adult AI persona aged 20"
          className="h-10 w-10 rounded-full border border-cyan-200/30 object-cover object-center"
          loading="lazy"
        />
        <div className="pr-1 leading-tight">
          <div className="text-[10px] font-semibold tracking-[0.18em] text-cyan-100">SARA</div>
          <div className="mt-1 text-[8px] font-mono tracking-[0.08em] text-slate-400">FICTIONAL AI · 20</div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-4 right-3 z-30 max-w-[170px] text-right text-[8px] leading-relaxed text-slate-400/85 sm:bottom-6 sm:right-6 sm:max-w-[220px]">
        {mode === "3d" ? "Procedural 3D · audio-energy mouth motion is approximate · avatar does not start camera/mic" : "Legacy MP4 fallback · not a rigged 3D model"}
      </div>

      <canvas id="sara-hologram-living-canvas" ref={canvasRef} className="pointer-events-none absolute inset-0 z-20 h-full w-full" aria-hidden="true" />
    </div>
  );
};
