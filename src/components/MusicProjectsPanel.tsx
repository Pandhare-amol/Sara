import { useEffect, useMemo, useState } from "react";
import { Check, FileMusic, RefreshCw, ShieldCheck, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

type MusicProject = { project_id: string; title: string; concept: string; genre: string; mood: string; language: string; production_status: string; publishing_status: string; updated_at: string };
type Workflow = { status: string; stage: string; progress: number; currentStep: string; error?: { message?: string } } | null;
type Props = { isOpen: boolean; onClose: () => void; userId?: string };

export function MusicProjectsPanel({ isOpen, onClose, userId = "default-user" }: Props) {
  const [projects, setProjects] = useState<MusicProject[]>([]);
  const [workflows, setWorkflows] = useState<Record<string, Workflow>>({});
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/music/projects?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
      const data = await response.json();
      const nextProjects = Array.isArray(data.projects) ? data.projects : [];
      setProjects(nextProjects);
      const entries = await Promise.all(nextProjects.map(async (project: MusicProject) => {
        const detail = await fetch(`/api/music/projects/${encodeURIComponent(project.project_id)}`, { cache: "no-store" }).then((res) => res.json());
        return [project.project_id, detail.workflow || null] as const;
      }));
      setWorkflows(Object.fromEntries(entries));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Music projects are unavailable.");
    } finally { setLoading(false); }
  };

  useEffect(() => { if (isOpen) void refresh(); }, [isOpen, userId]);

  const createProject = async () => {
    const value = prompt.trim();
    if (!value || creating) return;
    setCreating(true); setNotice(null);
    try {
      const response = await fetch("/api/music/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: value, conversationId: typeof window !== "undefined" ? window.localStorage.getItem("sara.conversationId") : undefined, userId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create music project.");
      setPrompt(""); setNotice("Music project queued in the background."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not create music project."); }
    finally { setCreating(false); }
  };

  const prepare = async (projectId: string) => {
    const response = await fetch(`/api/music/projects/${encodeURIComponent(projectId)}/prepare-publishing`, { method: "POST" });
    const data = await response.json();
    setNotice(data.readiness?.ready ? "Publishing is ready after approval." : "Publishing is not ready: a verified video and approval are still required.");
    await refresh();
  };

  const approve = async (projectId: string) => {
    const response = await fetch(`/api/music/projects/${encodeURIComponent(projectId)}/approve-publishing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approvedBy: userId }) });
    const data = await response.json();
    setNotice(response.ok && data.readiness?.approved ? "Publishing approval recorded." : data.error || "Approval failed.");
    await refresh();
  };

  const orderedProjects = useMemo(() => [...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [projects]);

  return <AnimatePresence>{isOpen ? <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} className="absolute inset-y-10 right-10 z-50 flex max-h-[calc(100vh-5rem)] min-h-0 w-[calc(100%-2.5rem)] max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl">
    <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/90 px-6 py-4"><div className="flex items-center gap-3"><FileMusic size={18} className="text-cyan-300" /><div><h2 className="text-base font-semibold text-white">Music Projects</h2><p className="text-xs text-slate-400">Track real creation stages and publishing readiness.</p></div></div><div className="flex items-center gap-2"><button onClick={() => void refresh()} aria-label="Refresh music projects" className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-2 text-cyan-200"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button><button onClick={onClose} aria-label="Close music projects" className="rounded-2xl p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X size={18} /></button></div></div>
    <div className="border-b border-white/5 bg-white/5 p-6"><div className="flex gap-2"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} placeholder="Create an emotional Hindi song for students" className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" /><button onClick={() => void createProject()} disabled={creating || !prompt.trim()} className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">{creating ? "Queuing" : "Create"}</button></div>{notice && <p className="mt-3 text-xs text-cyan-200">{notice}</p>}</div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">{orderedProjects.length === 0 ? <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-slate-400">No music projects yet.</div> : orderedProjects.map((project) => { const workflow = workflows[project.project_id]; return <article key={project.project_id} className="rounded-3xl border border-white/10 bg-slate-900/90 p-4"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white">{project.title || "Untitled Project"}</h3><p className="mt-1 line-clamp-2 text-xs text-slate-400">{project.concept || "Creative concept is being prepared."}</p><div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>{project.language || "Language pending"}</span><span>{project.genre || "Genre pending"}</span><span>{project.production_status}</span><span>{project.publishing_status}</span></div></div><span className="shrink-0 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200">{workflow?.stage || project.production_status}</span></div>{workflow && <div className="mt-4"><div className="flex justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>{workflow.currentStep}</span><span>{workflow.progress}%</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${workflow.progress}%` }} /></div>{workflow.error?.message && <p className="mt-2 text-xs text-rose-300">{workflow.error.message}</p>}</div>}<div className="mt-4 flex flex-wrap gap-2"><button onClick={() => void prepare(project.project_id)} className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10"><ShieldCheck size={14} />Prepare publishing</button>{project.publishing_status === "USER_APPROVAL" && <button onClick={() => void approve(project.project_id)} className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/15"><Check size={14} />Approve draft</button>}</div></article>; })}</div>
  </motion.div> : null}</AnimatePresence>;
}
