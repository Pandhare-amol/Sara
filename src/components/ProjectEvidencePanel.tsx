import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, Download, X } from "lucide-react";
import type { GeneralProject } from "../services/LocalProjectManager";
import type { EvidenceReport, BoardLifecycle } from "../core/projects/evidenceBoard";

type ResearchTask = { id: string; question: string; status: string;
  sources: Array<{ id: string; url: string; title: string; contentHash: string; status: string }> };
type Knowledge = { id: string; name: string; version: number; status: string;
  evidence: Array<{ url: string; sourceHash: string }> };
type StudioJob = { id: string; status: string; request: { modality: string }; artifactId?: string };
type Artifact = { id: string; fileName: string; kind: string; format: string;
  parentId?: string; provider: string; sha256: string; estimatedCostUsd?: number };
type Readiness = { status: string; total?: number; categories?: Record<string, number>; note?: string };
const safeId = (id: string) => encodeURIComponent(id);

/** Private companion to existing general projects, NOT a new project catalogue.
 * No provider API call is made here: creation stays in Studio with its own consent/budget gate.
 */
export function ProjectEvidencePanel({ project, onClose, onOpenStudio }: {
  project: GeneralProject; onClose: () => void; onOpenStudio: () => void;
}) {
  const [secretInput, setSecretInput] = useState("");
  const [admin, setAdmin] = useState("");
  const [report, setReport] = useState<EvidenceReport | null>(null);
  const [research, setResearch] = useState<ResearchTask[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [taskId, setTaskId] = useState(""); const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [knowledgeId, setKnowledgeId] = useState(""); const [jobId, setJobId] = useState("");
  const [artifactId, setArtifactId] = useState(""); const [briefDraft, setBriefDraft] = useState("");
  const [briefAcknowledged, setBriefAcknowledged] = useState(false);
  const [fileAcknowledged, setFileAcknowledged] = useState(false);
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const lastReleaseScan = useRef(0);
  // An older response must never restore private data after token revocation,
  // project switching, unmounting, or a newer check of the same board.
  const accessEpoch = useRef(0), refreshSequence = useRef(0);
  const base = `/api/projects/${safeId(project.id)}/evidence`;
  const clearOwnerState = (reason = "") => {
    accessEpoch.current++; refreshSequence.current++; lastReleaseScan.current = 0;
    setAdmin(""); setSecretInput(""); setReport(null); setReadiness(null); setBusy(false);
    setResearch([]); setKnowledge([]); setJobs([]); setArtifacts([]);
    setTaskId(""); setSourceIds([]); setKnowledgeId(""); setJobId(""); setArtifactId("");
    setBriefDraft(""); setBriefAcknowledged(false); setFileAcknowledged(false);
    setCheckFailed(true); setLastCheckedAt(null); setNotice(reason);
  };
  const revoked = "Owner access ended or protected mode is active. Private project data was cleared from this panel.";
  const request = async (route: string, method = "GET", data?: unknown) => {
    const epoch = accessEpoch.current;
    const response = await fetch(route, { method, mode: "same-origin", cache: "no-store", redirect: "error",
      headers: { "X-Admin-Token": admin, ...(data !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    if (epoch !== accessEpoch.current) throw new Error("Owner session changed; refresh before retrying.");
    if (response.status === 401 || response.status === 403) {
      clearOwnerState(revoked);
      throw new Error(revoked);
    }
    const payload = await response.json().catch(() => ({}));
    if (epoch !== accessEpoch.current) throw new Error("Owner session changed; refresh before retrying.");
    if (!response.ok) throw new Error(payload.error || `Owner request denied (${response.status}).`);
    return payload;
  };
  const refresh = async (forceReleaseScan = false) => {
    const epoch = accessEpoch.current, sequence = ++refreshSequence.current;
    try {
      const [boardResponse, sourceList, entries, studioJobs, files] = await Promise.all([
        fetch(base, { headers: { "X-Admin-Token": admin }, cache: "no-store", mode: "same-origin", redirect: "error" }),
        request("/api/research/tasks"), request("/api/knowledge"),
        request("/api/studio/jobs"), request("/api/studio/artifacts"),
      ]);
      if (epoch !== accessEpoch.current || sequence !== refreshSequence.current) return;
      if (boardResponse.status === 401 || boardResponse.status === 403) {
        clearOwnerState(revoked);
        throw new Error(revoked);
      }
      const boardResult = await boardResponse.json().catch(() => ({}));
      if (epoch !== accessEpoch.current || sequence !== refreshSequence.current) return;
      if (!boardResponse.ok && boardResponse.status !== 404) throw new Error(boardResult.error || "Evidence board unavailable.");
      setReport(boardResponse.ok ? boardResult.report : null);
      setResearch(sourceList.tasks || []); setKnowledge(entries.items || []);
      setJobs(studioJobs.jobs || []); setArtifacts(files.artifacts || []);
      setLastCheckedAt(Date.now()); setCheckFailed(false);
      if (forceReleaseScan || Date.now() - lastReleaseScan.current > 60_000) {
        lastReleaseScan.current = Date.now();
        try {
          const status = await request("/api/owner/release-readiness");
          if (epoch === accessEpoch.current && sequence === refreshSequence.current) setReadiness(status);
        } catch {
          if (epoch === accessEpoch.current && sequence === refreshSequence.current) {
            setReadiness({ status: "UNAVAILABLE", note: "Release gate cannot be checked here; treat release as blocked." });
          }
        }
      }
    } catch (error) {
      if (epoch === accessEpoch.current && sequence === refreshSequence.current) setCheckFailed(true);
      throw error;
    }
  };
  useEffect(() => {
    if (!admin) return;
    const epoch = accessEpoch.current;
    void refresh().catch((error) => {
      if (epoch === accessEpoch.current) setNotice(error instanceof Error ? error.message : "Evidence unavailable.");
    });
    const timer = window.setInterval(() => {
      void refresh().catch(() => { /* The last-known checkpoint is visibly marked stale. */ });
    }, 8000);
    return () => { window.clearInterval(timer); accessEpoch.current++; refreshSequence.current++; };
  }, [admin, project.id]);
  // A background job/source refresh must not erase unsaved typing. Only a
  // changed saved brief (or another selected project) resets the draft.
  useEffect(() => { setBriefDraft(report?.board.brief || ""); }, [report?.board.brief, project.id]);
  useEffect(() => { setBriefAcknowledged(false); setFileAcknowledged(false); }, [report?.board.revision, project.id]);
  useEffect(() => { clearOwnerState(); }, [project.id]);
  const act = async (action: () => Promise<unknown>, message: string) => {
    const epoch = accessEpoch.current;
    setBusy(true); setNotice("");
    try {
      await action();
      if (epoch !== accessEpoch.current) return;
      await refresh();
      if (epoch === accessEpoch.current) setNotice(message);
    } catch (error) {
      if (epoch === accessEpoch.current) setNotice(error instanceof Error ? error.message : "Project change not verified.");
    } finally { if (epoch === accessEpoch.current) setBusy(false); }
  };
  const approved = (extra: Record<string, unknown> = {}) => ({ confirm: true, expectedRevision: report?.board.revision, ...extra });
  const unlink = (category: "sources" | "knowledge" | "jobs" | "artifacts", id: string) => {
    if (!window.confirm(`Unlink this ${category.slice(0, -1)} from the evidence board? This does not delete the original record or file.`)) return;
    void act(() => request(`${base}/links/${category}/${safeId(id)}`, "DELETE", approved()),
      "Link removed. Original files, tasks and sources were not deleted. Re-review changed evidence before accepting.");
  };
  const selectedTask = research.find((task) => task.id === taskId && task.status === "COMPLETED");
  const active = report?.board.lifecycle === "ACTIVE" && report.project?.status === "active" &&
    !checkFailed && lastCheckedAt !== null;
  return <div role="dialog" aria-modal="true" aria-label="Evidence-backed project workflow"
    className="fixed inset-0 z-[90] flex justify-center bg-black/90 p-2 sm:p-7 text-white">
    <div className="w-full max-w-5xl max-h-full overflow-y-auto rounded-2xl border border-cyan-400/25 bg-[#0b1220] p-4 sm:p-7 shadow-2xl space-y-5 select-text">
      <header className="flex justify-between gap-4 border-b border-white/10 pb-4">
        <div><h2 className="flex items-center gap-2 text-xl font-semibold"><ClipboardCheck size={19} /> Evidence & approvals</h2>
          <p className="text-sm text-white/75">{report?.project?.title || project.title} · local project, private owner-only evidence ledger</p>
          <p className="text-xs text-amber-200">This is not a fact checker, model test, deployment gate or certificate. Provider calls are made only in CREATE with separate approval.</p></div>
        <button type="button" aria-label="Close evidence board" onClick={onClose}><X /></button>
      </header>
      {!admin ? <section className="space-y-3 text-sm"><label className="block">Local owner approval token (memory only)
          <input type="password" autoComplete="off" value={secretInput} onChange={(event) => setSecretInput(event.target.value)}
            className="mt-1 block w-full max-w-sm rounded bg-white/10 p-2" /></label>
        <button type="button" className="rounded bg-cyan-800 px-4 py-2" onClick={() => { setAdmin(secretInput); setSecretInput(""); }}>Unlock evidence board</button>
        <p className="text-amber-200">Protected multi-user mode denies this legacy owner-only feature; no cross-user sharing.</p></section>
      : <>
        <div className="flex flex-wrap items-center gap-3 text-xs text-white/70">
          <button type="button" className="underline" onClick={() => void refresh(true).catch((error) => setNotice(String(error)))}>Refresh checked state</button>
          <span role="status" className={checkFailed ? "text-amber-200" : "text-white/60"}>
            {checkFailed ? "Latest evidence check failed; details below are last-known only. Retry before approval." :
              lastCheckedAt ? `Evidence last checked ${new Date(lastCheckedAt).toLocaleTimeString()}.` : "Checking private evidence…"}
          </span>
          <span>Release index: {readiness?.status || "checking"}{typeof readiness?.total === "number" ? ` · ${readiness.total} tracked sensitive/generated paths` : ""}</span>
          <span className="text-amber-200">{readiness?.note}</span>
        </div>
        {!report ? <section className="rounded-xl border border-white/15 p-4 space-y-2">
          <h3 className="font-semibold">Begin a board for this existing project</h3>
          <p className="text-sm text-white/60">No files are generated and no research is fetched. This only creates a private checkpoint ledger.</p>
          <button disabled={busy || checkFailed || !lastCheckedAt || project.status !== "active"} className="rounded bg-cyan-800 px-3 py-2 disabled:opacity-40" onClick={() => {
            if (window.confirm("Start a private evidence board for this project? No provider or research request will run."))
              void act(() => request(base, "POST", { confirm: true }), "Evidence board created; link actual approved sources next.");
          }}>Create evidence board</button></section>
        : <>
          <section className="rounded-xl border border-white/15 p-4 space-y-3">
            <div className="flex flex-wrap gap-3 items-center"><h3 className="font-semibold">{checkFailed ? "Last-known checkpoint" : "Current checkpoint"}: {report.phase}</h3>
              <span className="text-xs text-white/60">Revision {report.board.revision} · no automatic actions</span></div>
            {report.blockers.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-200 space-y-1">
              {report.blockers.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>}
            <p className="text-xs text-white/55">{report.disclaimer}</p>
            {report.blockers.some((issue) => issue.startsWith("General project details changed")) && report.project &&
              <div className="rounded border border-cyan-500/40 p-3 text-xs space-y-2">
                <p className="text-amber-200">General project changed since approval. Review the current server record below before binding this brief to it:</p>
                <p>Title: {report.project.title}</p><p className="whitespace-pre-wrap">Description: {report.project.description || "(none)"}</p>
                <p>Status: {report.project.status} · Due: {report.project.dueDate || "none"}</p>
                <button type="button" disabled={!active || busy || checkFailed || !report.currentProjectFingerprint}
                  className="text-cyan-300 underline disabled:opacity-40" onClick={() => {
                    if (!window.confirm("I reviewed the displayed title, description, status and due date. Rebind only this exact project version and clear both prior approvals?")) return;
                    void act(() => request(`${base}/project-details/review`, "POST",
                      approved({ currentProjectFingerprint: report.currentProjectFingerprint })),
                      "Project details rebound. Re-review the brief and saved output before accepting.");
                  }}>Review changed project details & rebind</button>
              </div>}
            <div className="flex flex-wrap gap-2 text-xs">
              {(["PAUSED", "CANCELLED", "ACTIVE"] as BoardLifecycle[]).filter((state) => state !== report.board.lifecycle).map((state) =>
                <button key={state} type="button" disabled={busy || checkFailed || !lastCheckedAt} className="rounded border border-white/20 px-3 py-1.5 disabled:opacity-40" onClick={() => {
                  if (!window.confirm(`${state === "ACTIVE" ? "Resume" : state === "PAUSED" ? "Pause" : "Cancel"} this board? Studio and research jobs are separate; no file is deleted and cancellation of those jobs needs its own approval.`)) return;
                  void act(() => request(`${base}/lifecycle`, "POST", approved({ lifecycle: state })),
                    `${state} recorded. Existing jobs and files are separate; inspect them before any retry.`);
                }}>{state === "ACTIVE" ? "Resume board" : state === "PAUSED" ? "Pause board" : "Cancel board"}</button>)}
            </div>
          </section>
          <section className="rounded-xl border border-white/15 p-4 space-y-3"><h3 className="font-semibold">1 · Link retrieved sources (unverified)</h3>
            <p className="text-xs text-white/60">First retrieve exact authorized HTTPS documents in LEARN. No web requests happen here.</p>
            <label className="block text-xs">Completed research task<select aria-label="Select completed research task" className="mt-1 block w-full rounded bg-slate-900 p-2"
              value={taskId} onChange={(event) => { setTaskId(event.target.value); setSourceIds([]); }}>
              <option value="">Select a task</option>{research.filter((task) => task.status === "COMPLETED").map((task) =>
                <option key={task.id} value={task.id}>{task.question.slice(0, 95)}</option>)}</select></label>
            {selectedTask?.sources.map((source) => <label key={source.id} className="block text-xs break-all"><input type="checkbox" checked={sourceIds.includes(source.id)}
              onChange={() => setSourceIds((ids) => ids.includes(source.id) ? ids.filter((entry) => entry !== source.id) : [...ids, source.id])} /> {source.title}: {source.url} · retrieved_unverified</label>)}
            <button type="button" disabled={!active || busy || !sourceIds.length} className="rounded bg-cyan-800 px-3 py-2 text-xs disabled:opacity-40"
              onClick={() => void act(() => request(`${base}/sources`, "POST", approved({ researchTaskId: taskId, sourceIds })),
                "Source IDs and hashes linked; their passages remain untrusted data.")}>Link selected source IDs</button>
            {report.board.sources.map((link) => <div key={link.sourceId} className="flex gap-3 text-xs break-all border-l border-cyan-500 pl-2">
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">{link.url}</a><span>SHA-256 {link.contentHash.slice(0, 16)}…</span>
              <button type="button" className="text-amber-300 underline" disabled={!active || busy} onClick={() => unlink("sources", link.sourceId)}>Unlink</button></div>)}
            <div className="flex gap-2 items-center text-xs"><label className="flex-1">Optional reviewed knowledge<select aria-label="Reviewed knowledge" className="mt-1 w-full rounded bg-slate-900 p-2" value={knowledgeId}
              onChange={(event) => setKnowledgeId(event.target.value)}><option value="">Select source-linked item</option>
              {knowledge.filter((item) => ["supported", "verified"].includes(item.status) && item.evidence.some((entry) =>
                report.board.sources.some((link) => link.url === entry.url && link.contentHash === entry.sourceHash)))
                .map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status} v{item.version}</option>)}</select></label>
              <button disabled={!active || busy || !knowledgeId} className="rounded bg-cyan-800 px-3 py-2 disabled:opacity-40" onClick={() => void act(
                () => request(`${base}/knowledge`, "POST", approved({ knowledgeId })), "Reviewed knowledge linked; this is not an execution grant.")}>Link</button></div>
            {report.board.knowledge.map((entry) => <div key={entry.id} className="text-xs flex gap-2"><span>Knowledge {entry.id.slice(0, 8)} · v{entry.version}</span>
              <button disabled={!active || busy} onClick={() => unlink("knowledge", entry.id)} className="text-amber-300 underline">Unlink</button></div>)}
          </section>
          <section className="rounded-xl border border-white/15 p-4 space-y-3"><h3 className="font-semibold">2 · Write and review your brief</h3>
            <textarea aria-label="Human-authored project brief" maxLength={4000} rows={5} value={briefDraft} onChange={(event) => setBriefDraft(event.target.value)}
              placeholder="Write your own bounded conclusion with limitations. Source text is not an instruction to SARA." className="w-full rounded bg-white/10 p-2 text-sm" />
            <button disabled={!active || busy || briefDraft.trim().length < 20 || briefDraft === report.board.brief}
              className="rounded bg-cyan-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => void act(
                () => request(`${base}/brief`, "PUT", approved({ brief: briefDraft })), "Brief saved, not independently checked. Previous approvals invalidated.")}>Save new brief revision</button>
            <p className="text-xs text-white/55 break-all">Exact brief/source digest: {report.briefDigest}</p>
            <label className="block text-xs"><input type="checkbox" checked={briefAcknowledged} onChange={(event) => setBriefAcknowledged(event.target.checked)} /> I read these sources and this exact brief; review does not verify source claims.</label>
            <button disabled={!active || busy || checkFailed || !lastCheckedAt || !briefAcknowledged || report.briefBlockers.length > 0 || briefDraft !== report.board.brief}
              className="rounded bg-cyan-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => {
                if (!window.confirm("Review this exact source-linked brief as human-authored, NOT as independently fact-checked?")) return;
                void act(() => request(`${base}/brief/review`, "POST", approved({ digest: report.briefDigest, acknowledgeUnverified: true })),
                  "Brief marked human-reviewed. No skill or factual claim was independently verified.");
              }}>Review exact brief (not fact-checked)</button>
          </section>
          <section className="rounded-xl border border-white/15 p-4 space-y-3"><h3 className="font-semibold">3 · Link existing Studio jobs and saved files</h3>
            <p className="text-xs text-white/60">Creation happens in the separate Studio approval, provider, budget and cancellation path. This board never submits a billable job.</p>
            <button type="button" className="text-fuchsia-300 underline text-xs" onClick={onOpenStudio}>Open CREATE in its own approval flow</button>
            <div className="flex flex-wrap gap-2 items-end"><label className="flex-1 text-xs">Studio job<select aria-label="Select Studio job" className="mt-1 w-full rounded bg-slate-900 p-2" value={jobId} onChange={(event) => setJobId(event.target.value)}>
              <option value="">Select a job</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.request.modality} · {job.status} · {job.id.slice(0, 8)}</option>)}</select></label>
              <button disabled={!active || busy || !jobId} className="rounded bg-fuchsia-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => void act(
                () => request(`${base}/jobs`, "POST", approved({ jobId })), "Studio job linked; its live state still needs checking.")}>Link job</button></div>
            {report.linkedJobs.map((job) => <div key={job.id} className="text-xs flex flex-wrap gap-2 border-l border-white/30 pl-2"><span>Job {job.id.slice(0, 8)} · {job.status}{job.artifactId ? ` · file ${job.artifactId.slice(0, 8)}` : ""}</span>
              {["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status) && <button disabled={busy || checkFailed || !lastCheckedAt} className="text-amber-300 underline disabled:opacity-40" onClick={() => {
                if (!window.confirm("Request cancellation of this exact Studio job? Provider work may still complete or be billed.")) return;
                void act(() => request(`${base}/jobs/${safeId(job.id)}/cancel`, "POST", approved()),
                  "Cancellation requested. Poll the Studio job before claiming it stopped.");
              }}>Request job cancellation</button>}
              <button disabled={!active || busy} className="text-amber-300 underline" onClick={() => unlink("jobs", job.id)}>Unlink</button></div>)}
            <div className="flex flex-wrap gap-2 items-end"><label className="flex-1 text-xs">Saved file (server checks its bytes and SHA-256)<select aria-label="Select saved Studio file" className="mt-1 w-full rounded bg-slate-900 p-2" value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>
              <option value="">Select a saved file</option>{artifacts.map((file) => <option key={file.id} value={file.id}>{file.fileName} · {file.provider}{file.parentId ? " · revision" : ""}</option>)}</select></label>
              <button disabled={!active || busy || !artifactId} className="rounded bg-fuchsia-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => void act(
                () => request(`${base}/artifacts`, "POST", approved({ artifactId })), "Validated private file linked. Content still needs human review.")}>Link saved file</button></div>
            {report.board.artifacts.map((link) => <div key={link.id} className="flex flex-wrap gap-2 text-xs border-l border-fuchsia-600 pl-2"><span>{link.format} · {link.id.slice(0, 8)} · {link.provider} · SHA-256 {link.sha256.slice(0, 14)}…{link.parentId ? " · revision linked to original" : ""}</span>
              <button disabled={!active || busy} className="text-amber-300 underline" onClick={() => unlink("artifacts", link.id)}>Unlink (does not delete)</button></div>)}
          </section>
          <section className="rounded-xl border border-white/15 p-4 space-y-3"><h3 className="font-semibold">4 · Manual acceptance and private manifest</h3>
            <p className="text-xs text-white/65">Estimated cost of linked saved files: {report.estimatedCostUsd === null ? "unknown" : `$${report.estimatedCostUsd.toFixed(4)}`}. Failed calls can still bill; this is not an invoice.</p>
            <p className="text-xs break-all text-white/55">Exact manifest digest: {report.manifestDigest}</p>
            {report.warnings.map((warning) => <p key={warning} className="text-xs text-amber-200">• {warning}</p>)}
            <label className="block text-xs"><input type="checkbox" checked={fileAcknowledged} onChange={(event) => setFileAcknowledged(event.target.checked)} /> I inspected all linked saved files and limitations. This accepts manual use only; it does not deploy, publish or certify content.</label>
            <button disabled={!active || busy || checkFailed || !lastCheckedAt || !fileAcknowledged || report.blockers.length > 0}
              className="rounded bg-emerald-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => {
                if (!window.confirm("Human-accept this exact manifest for manual use only? No publication, skill promotion, code execution or production certification will occur.")) return;
                void act(() => request(`${base}/accept`, "POST", approved({ digest: report.manifestDigest, acknowledgeLimitations: true })),
                  "Human-accepted for manual use only. Production verification and deployment remain separate.");
              }}>Accept exact saved artifacts for manual use</button>
            <button type="button" disabled={busy || checkFailed || !lastCheckedAt}
              className="ml-2 text-xs text-cyan-300 underline disabled:opacity-40" onClick={() => void act(async () => {
              const response = await fetch(`${base}/manifest`, { headers: { "X-Admin-Token": admin }, cache: "no-store", redirect: "error", mode: "same-origin" });
              if (!response.ok) throw new Error("Private manifest export unavailable.");
              const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
              link.href = url; link.download = `project-evidence-${project.id}.json`; document.body.appendChild(link); link.click(); link.remove();
              window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
            }, "Manifest download requested; verify the browser actually saved it before sharing.")}> <Download size={12} className="inline" /> Export private JSON manifest</button>
          </section>
          <details className="text-xs text-white/50"><summary>Local activity (bounded; not tamper-proof)</summary><ul className="pl-4 list-disc">
            {report.board.events.slice(-20).map((event) => <li key={`${event.revision}-${event.action}`}>{event.at} · r{event.revision} · {event.action}</li>)}</ul></details>
        </>}
      </>}
      {notice && <p role="status" className="rounded border border-amber-500/30 bg-amber-950/20 p-3 text-xs break-words">{notice}</p>}
    </div>
  </div>;
}
