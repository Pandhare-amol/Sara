import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Circle, Clock3, FolderKanban, Plus, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { GeneralProject, GeneralProjectDetail, GeneralProjectSummary, GeneralTask, GeneralTaskStatus } from "../services/LocalProjectManager";

interface ProjectManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const taskStatusLabels: Record<GeneralTaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

function dateValue(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}

function toDueDate(value: string): string | undefined {
  return value ? new Date(`${value}T12:00:00`).toISOString() : undefined;
}

export function ProjectManagerPanel({ isOpen, onClose }: ProjectManagerPanelProps) {
  const [projects, setProjects] = useState<GeneralProjectSummary[]>([]);
  const [detail, setDetail] = useState<GeneralProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "normal" | "high">("normal");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async (includeArchived = showArchived) => {
    const response = await fetch(`/api/projects${includeArchived ? "?includeArchived=true" : ""}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not load projects.");
    setProjects(Array.isArray(payload.projects) ? payload.projects as GeneralProjectSummary[] : []);
  }, [showArchived]);

  const loadDetail = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not load project details.");
    setDetail({ project: payload.project as GeneralProject, tasks: Array.isArray(payload.tasks) ? payload.tasks as GeneralTask[] : [] });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadProjects();
      if (detail?.project.id) await loadDetail(detail.project.id);
    } catch (caught: any) {
      setError(caught?.message || "Project management is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [detail?.project.id, loadDetail, loadProjects]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    void loadProjects().catch((caught: any) => setError(caught?.message || "Could not load projects."));
  }, [isOpen, loadProjects]);

  useEffect(() => {
    if (isOpen && detail?.project.status === "archived" && !showArchived) setDetail(null);
  }, [isOpen, detail?.project.status, showArchived]);

  const selectProject = async (projectId: string) => {
    setError(null);
    setMessage(null);
    try { await loadDetail(projectId); }
    catch (caught: any) { setError(caught?.message || "Could not open project."); }
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: projectTitle, description: projectDescription }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not create project.");
      setProjectTitle("");
      setProjectDescription("");
      setShowProjectForm(false);
      await loadProjects();
      await loadDetail(payload.project.id);
      setMessage("Project created and saved locally.");
    } catch (caught: any) { setError(caught?.message || "Could not create project."); }
  };

  const createTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(detail.project.id)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: taskTitle,
          description: taskDescription,
          priority: taskPriority,
          dueDate: toDueDate(taskDueDate),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not add task.");
      setTaskTitle("");
      setTaskDescription("");
      setTaskPriority("normal");
      setTaskDueDate("");
      setShowTaskForm(false);
      await Promise.all([loadProjects(), loadDetail(detail.project.id)]);
      setMessage("Task added and saved locally.");
    } catch (caught: any) { setError(caught?.message || "Could not add task."); }
  };

  const updateProjectStatus = async (status: GeneralProject["status"]) => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(detail.project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not update project.");
      await Promise.all([loadProjects(), loadDetail(detail.project.id)]);
      setMessage(status === "archived" ? "Project archived. Its history remains saved." : "Project status updated.");
    } catch (caught: any) { setError(caught?.message || "Could not update project status."); }
  };

  const updateTaskStatus = async (taskId: string, status: GeneralTaskStatus) => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/project-tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Could not update task.");
      await Promise.all([loadProjects(), loadDetail(detail.project.id)]);
    } catch (caught: any) { setError(caught?.message || "Could not update task status."); }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.button type="button" aria-label="Close project manager overlay" className="fixed inset-0 z-[58] bg-black/65 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside role="dialog" aria-modal="true" aria-labelledby="project-manager-title" initial={{ opacity: 0, x: 32 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 32 }} className="fixed inset-y-0 right-0 z-[59] flex w-full max-w-5xl flex-col border-l border-cyan-300/15 bg-slate-950 text-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <h2 id="project-manager-title" className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em]"><FolderKanban size={17} className="text-cyan-300" /> Projects &amp; tasks</h2>
                <p className="mt-1 text-[10px] text-slate-500">General project tracking, separate from Music Studio projects. Saved locally on this device.</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-200 disabled:opacity-50" aria-label="Refresh projects"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button>
                <button type="button" onClick={onClose} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white" aria-label="Close project manager"><X size={15} /></button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <section className="flex max-h-[42vh] w-full flex-col border-b border-white/10 md:max-h-none md:w-[18rem] md:border-b-0 md:border-r" aria-label="Project list">
                <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Your projects</span>
                  <button type="button" onClick={() => setShowProjectForm((value) => !value)} className="flex items-center gap-1 rounded-lg bg-cyan-400/10 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-400/20"><Plus size={12} /> New</button>
                </div>
                <label className="flex items-center gap-2 px-4 py-2 text-[10px] text-slate-500"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); void loadProjects(event.target.checked).catch((caught: any) => setError(caught?.message || "Could not load archived projects.")); }} /> Include archived projects</label>
                <div className="flex-1 space-y-1 overflow-y-auto p-2">
                  {projects.length ? projects.map((project) => (
                    <button key={project.id} type="button" onClick={() => void selectProject(project.id)} className={`w-full rounded-xl border p-3 text-left transition ${detail?.project.id === project.id ? "border-cyan-300/35 bg-cyan-400/10" : "border-transparent hover:border-white/10 hover:bg-white/5"}`}>
                      <span className="block truncate text-xs font-semibold text-white">{project.title}</span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-[9px] text-slate-500"><span>{project.completedTaskCount}/{project.taskCount} tasks done</span><span className="uppercase tracking-wider">{project.status.replace("_", " ")}</span></span>
                    </button>
                  )) : <p className="px-3 py-6 text-center text-xs text-slate-500">No projects yet. Start with a small goal.</p>}
                </div>
              </section>

              <main className="min-h-0 flex-1 overflow-y-auto p-5">
                {error && <div className="mb-4 rounded-lg border border-rose-400/30 bg-rose-950/30 p-3 text-xs text-rose-200" role="alert">{error}</div>}
                {message && <div className="mb-4 rounded-lg border border-emerald-300/20 bg-emerald-950/20 p-3 text-xs text-emerald-100" role="status">{message}</div>}

                {showProjectForm && (
                  <form onSubmit={createProject} className="mb-5 rounded-xl border border-cyan-300/20 bg-cyan-950/15 p-4">
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-cyan-100">Create project</h3>
                    <label className="mb-2 block text-[10px] text-slate-400">Project name<input autoFocus required maxLength={160} value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} placeholder="e.g. Plan the studio launch" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50" /></label>
                    <label className="mb-3 block text-[10px] text-slate-400">Description<textarea maxLength={2000} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} rows={2} placeholder="What does success look like?" className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50" /></label>
                    <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowProjectForm(false)} className="rounded-lg px-3 py-2 text-[10px] text-slate-400 hover:text-white">Cancel</button><button type="submit" className="rounded-lg bg-cyan-400 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-950">Save project</button></div>
                  </form>
                )}

                {detail ? (
                  <>
                    <div className="mb-5 flex flex-col justify-between gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-start">
                      <div className="min-w-0"><p className="text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-300">Project</p><h3 className="mt-1 break-words text-xl font-semibold text-white">{detail.project.title}</h3><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{detail.project.description || "No description yet."}</p>{detail.project.dueDate && <p className="mt-2 text-[10px] text-slate-500">Target date: {new Date(detail.project.dueDate).toLocaleDateString()}</p>}</div>
                      <div className="flex shrink-0 items-center gap-2"><label className="sr-only" htmlFor="general-project-status">Project status</label><select id="general-project-status" value={detail.project.status} onChange={(event) => void updateProjectStatus(event.target.value as GeneralProject["status"])} className="rounded-lg border border-white/10 bg-slate-950 px-2.5 py-2 text-[9px] uppercase tracking-wider text-slate-200"><option value="active">Active</option><option value="on_hold">On hold</option><option value="completed">Completed</option><option value="archived">Archived</option></select></div>
                    </div>

                    <div className="mb-3 flex items-center justify-between gap-2"><div><h4 className="text-xs font-bold uppercase tracking-widest text-slate-200">Tasks</h4><p className="mt-1 text-[10px] text-slate-500">{detail.tasks.filter((task) => task.status === "done").length} of {detail.tasks.length} completed</p></div><button type="button" disabled={detail.project.status === "archived" || detail.project.status === "completed"} onClick={() => setShowTaskForm((value) => !value)} className="flex items-center gap-1 rounded-lg bg-cyan-400/10 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-40"><Plus size={12} /> Add task</button></div>

                    {showTaskForm && (
                      <form onSubmit={createTask} className="mb-4 rounded-xl border border-white/10 bg-slate-900/70 p-4">
                        <label className="mb-2 block text-[10px] text-slate-400">Task title<input autoFocus required maxLength={200} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Next concrete step" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50" /></label>
                        <label className="mb-2 block text-[10px] text-slate-400">Details<textarea maxLength={4000} value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} rows={2} className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50" /></label>
                        <div className="mb-3 grid grid-cols-2 gap-2"><label className="text-[10px] text-slate-400">Priority<select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as "low" | "normal" | "high")} className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-2 text-xs text-white"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label><label className="text-[10px] text-slate-400">Due date<input type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-2 text-xs text-white" /></label></div>
                        <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowTaskForm(false)} className="rounded-lg px-3 py-2 text-[10px] text-slate-400 hover:text-white">Cancel</button><button type="submit" className="rounded-lg bg-cyan-400 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-950">Save task</button></div>
                      </form>
                    )}

                    {detail.tasks.length ? <ul className="space-y-2">{detail.tasks.map((task) => <li key={task.id} className="flex flex-col gap-3 rounded-xl border border-white/8 bg-slate-900/55 p-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-start gap-2.5"><div className="mt-0.5 text-cyan-300">{task.status === "done" ? <CheckCircle2 size={16} /> : task.status === "blocked" ? <Clock3 size={16} className="text-amber-300" /> : <Circle size={16} />}</div><div className="min-w-0"><p className={`break-words text-xs font-semibold ${task.status === "done" ? "text-slate-400 line-through" : "text-white"}`}>{task.title}</p>{task.description && <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-slate-500">{task.description}</p>}<p className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">{task.priority} priority{task.dueDate ? ` · due ${new Date(task.dueDate).toLocaleDateString()}` : ""}</p></div></div><select aria-label={`Status for ${task.title}`} value={task.status} onChange={(event) => void updateTaskStatus(task.id, event.target.value as GeneralTaskStatus)} className="shrink-0 rounded-lg border border-white/10 bg-slate-950 px-2 py-2 text-[10px] text-slate-200">{Object.entries(taskStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></li>)}</ul> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center"><p className="text-xs text-slate-400">No tasks yet. Add a next step to make progress visible.</p></div>}
                  </>
                ) : !showProjectForm && <div className="flex h-full min-h-64 flex-col items-center justify-center text-center"><FolderKanban size={32} className="text-slate-700" /><h3 className="mt-4 text-sm font-semibold text-slate-300">Choose a project</h3><p className="mt-2 max-w-xs text-xs leading-relaxed text-slate-500">Create a project and break it into tasks. SARA stores this separately from music production workflows.</p></div>}
              </main>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
