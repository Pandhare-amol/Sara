import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Square, Volume2, Music2 } from "lucide-react";
import { AudioSessionManager } from "../services/audio/AudioSessionManager";

type Props = { conversationId?: string | null; conversationIds?: Array<string | null | undefined> };
type SingerTask = { taskId: string; status: string; progress: number; updatedAt?: string; error?: { message?: string }; session?: { language?: string; mood?: string; style?: string } };

export function SingerPlayer({ conversationId, conversationIds = [] }: Props) {
  const [task, setTask] = useState<SingerTask | null>(null);
  const [volume, setVolume] = useState(0.85);
  const audioRef = useRef<AudioSessionManager | null>(null);
  const activeConversations = useMemo(() => Array.from(new Set([
    conversationId,
    ...conversationIds,
    ...(typeof window !== "undefined" ? [window.localStorage.getItem("sara.conversationId")] : []),
  ].filter((value): value is string => Boolean(value)))), [conversationId, conversationIds]);

  useEffect(() => {
    const audio = new AudioSessionManager();
    audioRef.current = audio;
    return () => audio.stop();
  }, []);

  useEffect(() => {
    const onControl = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string; taskId?: string }>).detail;
      if (action.taskId && action.taskId !== task?.taskId) return;
      if (action.action === "STOP" || action.action === "CANCEL") { audioRef.current?.stop(); setTask((current) => current ? { ...current, status: "COMPLETED" } : current); }
      if (action.action === "PAUSE") { audioRef.current?.pause(); setTask((current) => current ? { ...current, status: "PAUSED" } : current); }
      if (action.action === "RESUME") { void audioRef.current?.resume(); setTask((current) => current ? { ...current, status: "PLAYING" } : current); }
    };
    window.addEventListener("sara.singerControl", onControl);
    return () => window.removeEventListener("sara.singerControl", onControl);
  }, [task?.taskId]);

  useEffect(() => {
    if (!activeConversations.length) return;
    let mounted = true;
    const load = async () => {
      try {
        const results = await Promise.all(activeConversations.map(async (conversation) => {
          const response = await fetch(`/api/singer/current?conversationId=${encodeURIComponent(conversation)}`);
          return response.json();
        }));
        const tasks = results.map((data) => data?.task).filter(Boolean) as SingerTask[];
        const newest = tasks.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0] || null;
        if (mounted) setTask(newest);
      } catch { /* the existing chat remains usable when singer status is unavailable */ }
    };
    void load();
    const timer = window.setInterval(load, 2500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [activeConversations]);

  if (!task) return null;
  const isBusy = ["QUEUED", "ANALYZING", "WRITING_LYRICS", "PREPARING_MUSIC", "GENERATING_VOCALS", "MIXING"].includes(task.status);
  const isPlaying = task.status === "PLAYING";
  const sendControl = async (action: string) => {
    if (action === "STOP" || action === "CANCEL") audioRef.current?.stop();
    if (action === "PAUSE") audioRef.current?.pause();
    if (action === "RESUME") await audioRef.current?.resume();
    if (action === "PAUSE") setTask((current) => current ? { ...current, status: "PAUSED" } : current);
    if (action === "RESUME") setTask((current) => current ? { ...current, status: "PLAYING" } : current);
    await fetch("/api/singer/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, taskId: task.taskId }) }).catch(() => {});
  };
  const play = async () => {
    try {
      await audioRef.current?.play(`/api/singer/tasks/${encodeURIComponent(task.taskId)}/audio`);
      setTask((current) => current ? { ...current, status: "PLAYING" } : current);
    } catch (error) {
      setTask((current) => current ? { ...current, status: "FAILED", error: { message: error instanceof Error ? error.message : "Audio playback failed." } } : current);
    }
  };

  return (
    <section className="fixed bottom-6 left-1/2 z-40 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl border border-cyan-400/20 bg-slate-950/90 p-4 text-white shadow-2xl backdrop-blur-xl" aria-label="SARA Singer Mode player">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Music2 size={18} className="shrink-0 text-cyan-300" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">SARA Singer Mode</p>
            <p className="truncate text-xs text-slate-400">{task.session?.language?.toUpperCase() || "SARA"} {task.session?.style || ""} {task.session?.mood || ""}</p>
          </div>
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-cyan-300">{task.status}</span>
      </div>
      {isBusy && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${task.progress}%` }} /></div>}
      {task.error?.message && <p className="mt-3 text-xs text-rose-300">{task.error.message}</p>}
      <div className="mt-3 flex items-center gap-2">
        {task.status === "READY" && <button onClick={play} aria-label="Play song" className="rounded-lg p-2 text-cyan-200 hover:bg-white/10"><Play size={16} /></button>}
        {isPlaying && <button onClick={() => void sendControl("PAUSE")} aria-label="Pause song" className="rounded-lg p-2 text-cyan-200 hover:bg-white/10"><Pause size={16} /></button>}
        {task.status === "PAUSED" && <button onClick={() => void sendControl("RESUME")} aria-label="Resume song" className="rounded-lg p-2 text-cyan-200 hover:bg-white/10"><Play size={16} /></button>}
        <button onClick={() => void sendControl("STOP")} aria-label="Stop song" className="rounded-lg p-2 text-slate-300 hover:bg-white/10"><Square size={16} /></button>
        <Volume2 size={15} className="ml-auto text-slate-400" />
        <input aria-label="Singer volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => { const next = Number(event.target.value); setVolume(next); audioRef.current?.setVolume(next); }} className="w-24 accent-cyan-400" />
      </div>
    </section>
  );
}
