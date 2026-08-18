import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Clock3, PauseCircle, PlayCircle, RefreshCw, Trash2, X } from "lucide-react";

type TaskStatus = "queued" | "planning" | "running" | "waiting" | "paused" | "retrying" | "completed" | "failed" | "cancelled";

type TaskRecord = {
  taskId: string;
  conversationId: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assignedAgent?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  result?: string;
  error?: string;
  metadata?: Record<string, any>;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

const statusStyles: Record<TaskStatus, string> = {
  queued: "border-slate-500/20 bg-slate-500/10 text-slate-200",
  planning: "border-cyan-500/20 bg-cyan-500/10 text-cyan-200",
  running: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  waiting: "border-indigo-500/20 bg-indigo-500/10 text-indigo-200",
  paused: "border-orange-500/20 bg-orange-500/10 text-orange-200",
  retrying: "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-200",
  completed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  failed: "border-rose-500/20 bg-rose-500/10 text-rose-200",
  cancelled: "border-white/10 bg-white/5 text-slate-300",
};

export function TaskManagerPanel({ isOpen, onClose }: Props) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [goal, setGoal] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [priority, setPriority] = useState(5);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks]);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data)) setTasks(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen]);

  const createTask = async () => {
    const trimmedGoal = goal.trim();
    const trimmedConversation = conversationId.trim();
    if (!trimmedGoal || !trimmedConversation) return;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: trimmedGoal, conversationId: trimmedConversation, priority }),
    });
    if (!res.ok) return;
    setGoal("");
    await refresh();
  };

  const patchTask = async (taskId: string, patch: Partial<TaskRecord>) => {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  };

  const deleteTask = async (taskId: string) => {
    await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    await refresh();
  };

  const confirmTask = async (task: TaskRecord) => {
    const confirmationId = task.metadata?.confirmationId;
    if (!confirmationId) {
      alert("No confirmation attached to this task.");
      return;
    }
    const token = window.prompt("Enter confirmation token to verify:");
    if (!token) return;
    const res = await fetch("/api/confirm/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: confirmationId, token }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Verification failed: ${data?.error || res.statusText}`);
    } else {
      await refresh();
      alert("Confirmation processed.");
    }
  };

  const resendConfirmation = async (task: TaskRecord) => {
    const confirmationId = task.metadata?.confirmationId;
    if (!confirmationId) {
      alert("No confirmation attached to this task.");
      return;
    }
    const res = await fetch("/api/confirm/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: confirmationId, taskId: task.taskId }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Resend failed: ${data?.error || res.statusText}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    // Show the token to the user in PoC mode
    alert(`New confirmation token: ${data.token}\nExpires: ${new Date(data.expiresAt).toLocaleString()}`);
  };

  const retryTask = async (task: TaskRecord) => {
    if (!window.confirm("Retry this task?")) return;
    const res = await fetch(`/api/tasks/${task.taskId}/retry`, { method: "POST", headers: { "Content-Type": "application/json" } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Retry failed: ${data?.error || res.statusText}`);
      return;
    }
    await refresh();
    alert("Retry submitted.");
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 30 }}
          className="absolute inset-y-10 right-10 z-50 w-full max-w-3xl rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-slate-900/90 px-6 py-4">
            <div>
              <h2 className="text-base font-semibold text-white">Task Orchestrator</h2>
              <p className="text-xs text-slate-400">Create, track, and update live task records.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={refresh} className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-500/15">
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              </button>
              <button onClick={onClose} className="rounded-2xl p-2 text-slate-400 hover:text-white hover:bg-white/5">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="grid gap-4 border-b border-white/5 bg-white/5 p-6 md:grid-cols-[1.3fr_0.7fr_0.5fr_auto]">
            <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Task goal" className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" />
            <input value={conversationId} onChange={(e) => setConversationId(e.target.value)} placeholder="Conversation ID" className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" />
            <input type="number" min={0} max={10} value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white focus:border-cyan-400 focus:outline-none" />
            <button onClick={createTask} className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Create Task</button>
          </div>

          <div className="max-h-[calc(100%-12.5rem)] overflow-y-auto p-6 space-y-3">
            {sortedTasks.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-slate-400">No tasks yet.</div>
            ) : (
              sortedTasks.map((task) => (
                <div key={task.taskId} className="rounded-3xl border border-white/10 bg-slate-900/90 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${statusStyles[task.status]}`}>{task.status}</span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">P{task.priority}</span>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{task.assignedAgent || "unassigned"}</span>
                      </div>
                      <p className="text-sm text-white leading-6">{task.description}</p>
                      <div className="flex flex-wrap gap-3 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                        <span className="inline-flex items-center gap-1"><Clock3 size={12} /> {new Date(task.createdAt).toLocaleString()}</span>
                        {task.completedAt ? <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} /> {new Date(task.completedAt).toLocaleString()}</span> : null}
                        {task.retryCount ? <span>Retries {task.retryCount}</span> : null}
                      </div>
                      {task.result ? <p className="text-xs text-emerald-300/80 whitespace-pre-line">{task.result}</p> : null}
                      {task.error ? <p className="text-xs text-rose-300/80 whitespace-pre-line">{task.error}</p> : null}
                    </div>
                    <div className="flex flex-col gap-2">
                      {task.status === "waiting" ? (
                        <div className="flex flex-col gap-2">
                          <button onClick={() => confirmTask(task)} className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-2 text-indigo-200 hover:bg-indigo-500/15">Confirm</button>
                          <button onClick={() => resendConfirmation(task)} className="rounded-2xl border border-sky-500/20 bg-sky-500/10 p-2 text-sky-200 hover:bg-sky-500/15">Resend</button>
                        </div>
                      ) : (
                        <button onClick={() => patchTask(task.taskId, { status: "running", startedAt: new Date().toISOString() })} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-2 text-amber-200 hover:bg-amber-500/15"><PlayCircle size={16} /></button>
                      )}
                      <button onClick={() => patchTask(task.taskId, { status: "paused" })} className="rounded-2xl border border-orange-500/20 bg-orange-500/10 p-2 text-orange-200 hover:bg-orange-500/15"><PauseCircle size={16} /></button>
                      <button onClick={() => patchTask(task.taskId, { status: "completed", completedAt: new Date().toISOString() })} className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-200 hover:bg-emerald-500/15"><CheckCircle2 size={16} /></button>
                      <button onClick={() => retryTask(task)} className="rounded-2xl border border-violet-500/20 bg-violet-500/10 p-2 text-violet-200 hover:bg-violet-500/15"><RefreshCw size={16} /></button>
                      <button onClick={() => deleteTask(task.taskId)} className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-2 text-rose-200 hover:bg-rose-500/15"><Trash2 size={16} /></button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
