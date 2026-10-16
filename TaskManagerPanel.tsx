import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Clock3, PauseCircle, PlayCircle, RefreshCw, Trash2, X } from "lucide-react";
import { apiFetch } from "./src/lib/userSession";
import { VisualTaskControls } from "./src/components/VisualTaskControls";

type TaskStatus = "queued" | "planning" | "running" | "cancelling" | "waiting" | "paused" | "retrying" | "completed" | "failed" | "cancelled" | "awaiting_confirmation" | "partial" | "timed_out" | "blocked";

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
  checkpoint?: { task_progress?: number; currentIndex?: number; uncertainStepIndex?: number; pendingApproval?: number; expectedPostcondition?: string; completed?: Array<{ index: number; action: string; evidence: string; observedAt?: string }>; stopRequested?: string };
  metadata?: Record<string, any>;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  activeConversationId?: string | null;
};

const statusStyles: Record<TaskStatus, string> = {
  queued: "border-slate-500/20 bg-slate-500/10 text-slate-200",
  planning: "border-cyan-500/20 bg-cyan-500/10 text-cyan-200",
  running: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  cancelling: "border-orange-500/30 bg-orange-500/10 text-orange-200",
  waiting: "border-indigo-500/20 bg-indigo-500/10 text-indigo-200",
  paused: "border-orange-500/20 bg-orange-500/10 text-orange-200",
  retrying: "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-200",
  completed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  failed: "border-rose-500/20 bg-rose-500/10 text-rose-200",
  cancelled: "border-white/10 bg-white/5 text-slate-300",
  awaiting_confirmation: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  partial: "border-orange-500/30 bg-orange-500/10 text-orange-200",
  timed_out: "border-orange-500/30 bg-orange-500/10 text-orange-200",
  blocked: "border-rose-500/30 bg-rose-500/10 text-rose-200",
};

export function TaskManagerPanel({ isOpen, onClose, activeConversationId }: Props) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tasksLocked, setTasksLocked] = useState(false);
  const [goal, setGoal] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [priority, setPriority] = useState(5);
  const [browserGoal, setBrowserGoal] = useState("");
  const [browserUrl, setBrowserUrl] = useState("");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const latestRefresh = useRef(0);

  const sortedTasks = useMemo(() => tasks
    .filter((task) => showAll || !activeConversationId || task.conversationId === activeConversationId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks, showAll, activeConversationId]);

  const refresh = async (silent = false) => {
    const generation = ++latestRefresh.current;
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch("/api/tasks", { cache: "no-store" });
      if (generation !== latestRefresh.current) return;
      if (res.status === 403 || res.status === 401) {
        setTasks([]); setTasksLocked(true);
        return;
      }
      if (!res.ok) throw new Error("Task status unavailable.");
      const data = await res.json();
      if (generation === latestRefresh.current && Array.isArray(data)) { setTasks(data); setTasksLocked(false); }
    } catch {
      if (generation === latestRefresh.current) setTasks([]); // never keep an earlier account's task list on a failed fetch
    } finally {
      if (generation === latestRefresh.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const interval = window.setInterval(() => { void refresh(true); }, 2500);
    const onAutomation = () => { void refresh(true); };
    const onAccountSwitch = () => { setTasks([]); void refresh(true); };
    window.addEventListener("sara.automationEvent", onAutomation);
    window.addEventListener("storage", onAccountSwitch);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("sara.automationEvent", onAutomation);
      window.removeEventListener("storage", onAccountSwitch);
    };
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

  const planBrowser = async (event: FormEvent) => {
    event.preventDefault();
    setWorkflowError(null);
    setWorkflowBusy(true);
    try {
      const response = await fetch("/api/workflows/browser/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: browserGoal, startUrl: browserUrl, conversationId: conversationId.trim() || "browser-workflow" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create a safe plan.");
      setBrowserGoal("");
      await refresh(true);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Could not plan browser workflow.");
    } finally { setWorkflowBusy(false); }
  };

  const workflowAction = async (task: TaskRecord, action: "start" | "approve" | "pause" | "cancel") => {
    setWorkflowError(null);
    setWorkflowBusy(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (action === "approve") {
        const token = sessionStorage.getItem("sara.adminToken") || "";
        const passkey = sessionStorage.getItem("sara.adminPasskeySession") || "";
        if (!token && !passkey) throw new Error("Sign in via Admin Security (token or passkey) before approving a browser action.");
        if (token) headers["X-Admin-Token"] = token;
        if (passkey) headers["X-SARA-Admin-Session"] = passkey;
        const step = task.metadata?.workflow?.steps?.[task.checkpoint?.pendingApproval ?? -1];
        if (!step || !window.confirm(`Approve this one browser action?\n${JSON.stringify(step, null, 2)}`)) return;
      }
      const response = await fetch(`/api/workflows/browser/${encodeURIComponent(task.taskId)}/${action}`, {
        method: "POST", headers,
        body: JSON.stringify(action === "approve" ? { approve: true, index: task.checkpoint?.pendingApproval, digest: task.metadata?.workflow?.digest } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Browser workflow request failed.");
      await refresh(true);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Browser workflow request failed.");
    } finally { setWorkflowBusy(false); }
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

  const automationAction = async (task: TaskRecord, action: "pause" | "resume" | "cancel") => {
    if (!task.metadata?.automation) return;
    if (action === "cancel" && !window.confirm(
      "Stop this selected automation task? Queued work stops now. An in-flight action may still finish and will need review; this does NOT stop SARA's speech.")) return;
    const res = await apiFetch(`/api/automation/tasks/${encodeURIComponent(task.taskId)}/${action}`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not change this automation task.");
    }
    await refresh(true);
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
              {activeConversationId && <button type="button" onClick={() => setShowAll((current) => !current)}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200"
                aria-label={showAll ? "Show current conversation tasks" : "Show all local tasks"}>
                {showAll ? "All tasks" : "This conversation"}
              </button>}
              <button onClick={refresh} className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-500/15">
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              </button>
              <button onClick={onClose} className="rounded-2xl p-2 text-slate-400 hover:text-white hover:bg-white/5">
                <X size={18} />
              </button>
            </div>
          </div>

          {tasksLocked ? (
            <div role="alert" className="p-6 text-sm text-amber-200">
              Task controls are unavailable in protected multi-user mode. Voice, desktop and legacy automation need trusted per-user authorization before they can be enabled.
            </div>
          ) : (<>
          <VisualTaskControls activeConversationId={activeConversationId} />
          <div className="grid gap-4 border-b border-white/5 bg-white/5 p-6 md:grid-cols-[1.3fr_0.7fr_0.5fr_auto]">
            <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Task goal" className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" />
            <input value={conversationId} onChange={(e) => setConversationId(e.target.value)} placeholder="Conversation ID" className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" />
            <input type="number" min={0} max={10} value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-white focus:border-cyan-400 focus:outline-none" />
            <button onClick={createTask} className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Create Task</button>
          </div>

          <form onSubmit={planBrowser} className="border-b border-white/10 bg-cyan-950/20 px-6 py-4 space-y-2">
            <p className="text-xs text-cyan-200 font-semibold">Reviewed browser workflow</p>
            <p className="text-[11px] text-slate-400">A separate temporary browser visits one public HTTPS hostname. Review the model plan before starting; clicks and form edits each need an admin-approved step.</p>
            <div className="flex flex-wrap gap-2">
              <input value={browserGoal} onChange={(e) => setBrowserGoal(e.target.value)} maxLength={500} required
                aria-label="Browser workflow goal" placeholder="What should Sara check on the site?"
                className="min-w-48 flex-[2] rounded-xl border border-white/10 bg-slate-950 p-2 text-xs text-white" />
              <input value={browserUrl} onChange={(e) => setBrowserUrl(e.target.value)} required type="url"
                aria-label="Starting HTTPS URL" placeholder="https://example.com/"
                className="min-w-40 flex-1 rounded-xl border border-white/10 bg-slate-950 p-2 text-xs text-white" />
              <button type="submit" disabled={workflowBusy} className="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50">Plan, don’t execute</button>
            </div>
            {workflowError && <p role="alert" className="text-xs text-red-300">{workflowError}</p>}
          </form>

          <div className="max-h-[calc(100%-19rem)] overflow-y-auto p-6 space-y-3">
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
                      {task.metadata?.automation && (
                        <div className="max-w-lg rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-3 text-xs text-slate-300 space-y-1">
                          <p className="font-mono text-cyan-200 break-all">{task.taskId}</p>
                          <p>Lifecycle progress {Math.min(100, Math.max(0, task.checkpoint?.task_progress ?? 0))}% · Only verified completion is final.</p>
                          {task.metadata.deadline_at && <p>Deadline: {new Date(task.metadata.deadline_at).toLocaleTimeString()}</p>}
                          {task.metadata.stop_requested_at && <p className="text-amber-200">Stop requested; in-flight work may still finish.</p>}
                          {task.metadata.review_required && <p className="text-orange-200">Review the external state before creating any new action. No automatic replay.</p>}
                        </div>
                      )}
                      {task.metadata?.workflow && (
                        <div className="max-w-lg space-y-2 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-3 text-xs text-slate-200">
                          <p className="font-semibold text-cyan-200">Browser plan · {task.metadata.workflow.host}</p>
                          <p className="text-slate-400">Static preview only, not a simulation. {task.metadata.workflow.steps?.filter((step: any) => step.action === "click" || step.action === "fill").length || 0} consequential step(s) need separate approval. Max 90 seconds of execution; provider cost depends on your model.</p>
                          <ol className="list-decimal pl-5 space-y-1 break-words">
                            {task.metadata.workflow.steps?.map((step: any, index: number) => (
                              <li key={index} className={task.checkpoint?.currentIndex === index ? "text-amber-200" : ""}>
                                <span className="font-semibold">{step.action}</span> · {step.url || step.name || step.label || step.contains || "Current page"}
                                {step.action === "fill" && <span> → {step.value}</span>}
                                {step.expect && <span> · verify {step.expect.type}: {step.expect.value}</span>}
                                {task.checkpoint?.completed?.some((item) => item.index === index) && <span className="text-emerald-300"> · verified</span>}
                              </li>
                            ))}
                          </ol>
                          {task.checkpoint?.expectedPostcondition && <p className="text-cyan-200">Expected: {task.checkpoint.expectedPostcondition}</p>}
                          {task.checkpoint?.completed?.length ? <p className="text-slate-400">Last observation {task.checkpoint.completed.at(-1)?.observedAt ? new Date(task.checkpoint.completed.at(-1)!.observedAt!).toLocaleString() : ""}: {task.checkpoint.completed.at(-1)?.evidence}</p> : null}
                          {task.checkpoint?.uncertainStepIndex !== undefined && <p className="text-amber-300">Outcome uncertain at step {task.checkpoint.uncertainStepIndex + 1}. Do not retry this plan.</p>}
                          {task.checkpoint?.stopRequested && <p className="text-amber-300">{task.checkpoint.stopRequested} requested; waiting for the in-flight browser call to return.</p>}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      {task.metadata?.automation ? (
                        <>
                          {task.status === "queued" && <button onClick={() => void automationAction(task, "pause")}
                            className="rounded-xl border border-orange-400/40 p-2 text-xs text-orange-200">Pause queued</button>}
                          {task.status === "paused" && !task.metadata.review_required && <button onClick={() => void automationAction(task, "resume")}
                            className="rounded-xl border border-cyan-400/40 p-2 text-xs text-cyan-200">Resume queued</button>}
                          {["queued", "running", "planning", "retrying", "waiting"].includes(task.status) &&
                            <button onClick={() => void automationAction(task, "cancel")}
                              className="rounded-xl border border-rose-400/40 p-2 text-xs text-rose-200">
                              {task.status === "queued" ? "Cancel task" : "Request stop"}
                            </button>}
                        </>
                      ) : task.metadata?.workflow ? (
                        <>
                          {task.status === "paused" && task.checkpoint?.uncertainStepIndex === undefined && <button disabled={workflowBusy} onClick={() => void workflowAction(task, "start")} className="rounded-xl bg-cyan-400 p-2 text-xs text-slate-950">Start reviewed plan</button>}
                          {task.status === "awaiting_confirmation" && <button disabled={workflowBusy} onClick={() => void workflowAction(task, "approve")} className="rounded-xl bg-amber-400 p-2 text-xs text-slate-950">Approve step {(task.checkpoint?.pendingApproval ?? 0) + 1}</button>}
                          {["running", "awaiting_confirmation"].includes(task.status) && <button disabled={workflowBusy} onClick={() => void workflowAction(task, "pause")} className="rounded-xl border border-orange-400/40 p-2 text-xs text-orange-200">Pause</button>}
                          {["paused", "running", "awaiting_confirmation"].includes(task.status) && <button disabled={workflowBusy} onClick={() => void workflowAction(task, "cancel")} className="rounded-xl border border-rose-400/40 p-2 text-xs text-rose-200">Cancel</button>}
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          </>)}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
