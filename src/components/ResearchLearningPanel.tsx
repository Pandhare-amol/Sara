import { useEffect, useState } from "react";
import { BookOpen, RefreshCw, X } from "lucide-react";

type Source = { id: string; url: string; title: string; retrievedAt: string; publishedOrUpdatedAt?: string;
  contentHash: string; passages: string[]; status: "retrieved_unverified" };
type Task = { id: string; question: string; urls: string[]; status: string; sources: Source[];
  failures: Array<{ url: string; reason: string }>; findingsStatus: string };
type Item = { id: string; version: number; name: string; kind: "topic" | "skill"; status: string;
  confidence: string; description: string; intendedUse: string; expiresAt: string;
  evidence: Array<{ url: string; text: string; retrievedAt: string; sourceHash: string }> };
type Plan = { id: string; itemId: string; enabled: boolean; intervalHours: number;
  lastCheckedAt?: string; lastResult?: string; taskId?: string };
type CodeArtifact = { id: string; fileName: string; kind: string; format: string; sha256: string };
type SkillAttempt = { id: string; skillId: string; skillVersion: number; codeArtifactId: string; codeSha256: string;
  testSha256: string; testSource: string; status: string; reason?: string; stdout?: string; stderr?: string;
  evidence?: { environment: string; completedAt: string; command: string; artifactHash: string } };


export function ResearchLearningPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [secretInput, setSecretInput] = useState("");
  const [admin, setAdmin] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [versions, setVersions] = useState<Record<string, Item[]>>({});
  const [codeArtifacts, setCodeArtifacts] = useState<CodeArtifact[]>([]);
  const [attempts, setAttempts] = useState<SkillAttempt[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [testSource, setTestSource] = useState("");
  const [codePreview, setCodePreview] = useState("");
  const [attemptDetail, setAttemptDetail] = useState<{ record: SkillAttempt; code: string | null } | null>(null);
  const [reviewedAttempt, setReviewedAttempt] = useState(false);
  const [sandbox, setSandbox] = useState<string>("unavailable / untested");
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(""); const [urls, setUrls] = useState("");
  const [taskId, setTaskId] = useState(""); const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState(""); const [kind, setKind] = useState<"topic" | "skill">("topic");
  const [procedure, setProcedure] = useState(""); const [expected, setExpected] = useState("");
  const [interval, setIntervalHours] = useState(24);
  const [quietStart, setQuietStart] = useState("22:00"); const [quietEnd, setQuietEnd] = useState("07:00");
  const [modelStatus, setModelStatus] = useState<string>("untested");
  const request = async (route: string, method = "GET", data?: unknown) => {
    const response = await fetch(route, { method, mode: "same-origin", redirect: "error", cache: "no-store",
      headers: { "X-Admin-Token": admin, ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request denied (${response.status}).`);
    return result;
  };
  const refresh = async () => {
    const [research, knowledge, schedule, verification, candidates, testHistory] = await Promise.all([
      request("/api/research/tasks"), request("/api/knowledge"),
      request("/api/refresh/plans"), request("/api/sandbox/status"),
      request("/api/studio/artifacts"), request("/api/skills/verifications")]);
    setTasks(research.tasks || []); setItems(knowledge.items || []);
    setPlans(schedule.plans || []);
    setCodeArtifacts((candidates.artifacts || []).filter((item: CodeArtifact) => item.kind === "code" && item.format === "py"));
    setAttempts(testHistory.attempts || []);
    setSandbox(verification.configured ? "configured, not independently tested on this device" : "off; no Docker execution claimed");
  };
  useEffect(() => {
    if (!isOpen || !admin) return;
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "Learning unavailable."));
    const timer = window.setInterval(() => {
      void refresh().catch(() => { /* Preserve the last explicit status; never invent a result. */ });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [isOpen, admin]);
  useEffect(() => {
    if (!isOpen) { setAdmin(""); setSecretInput(""); setTasks([]); setItems([]); setPlans([]); setVersions({});
      setCodeArtifacts([]); setAttempts([]); setCandidateId(""); setSkillId(""); setTestSource("");
      setCodePreview(""); setAttemptDetail(null); setReviewedAttempt(false); }
  }, [isOpen]);
  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setNotice("");
    try { await action(); await refresh(); setNotice(message); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Action could not be verified."); }
    finally { setBusy(false); }
  };
  const inspectCandidate = async (id: string) => {
    setCandidateId(id); setCodePreview("");
    if (!id) return;
    const response = await fetch(`/api/studio/artifacts/${encodeURIComponent(id)}/download`, {
      headers: { "X-Admin-Token": admin }, mode: "same-origin", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error("Candidate code could not be integrity-checked for review.");
    setCodePreview((await response.text()).slice(0, 30_000));
  };
  const selected = tasks.find((task) => task.id === taskId && task.status === "COMPLETED");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-center items-start bg-black/85 p-2 sm:p-8" role="dialog" aria-label="Research and learning dashboard" aria-modal="true">
      <div className="w-full max-w-5xl max-h-full overflow-y-auto rounded-2xl border border-cyan-400/25 bg-[#090d19] p-4 sm:p-7 text-white shadow-2xl space-y-5 select-text">
        <header className="flex items-start justify-between gap-4">
          <div><h2 className="flex items-center gap-2 text-xl font-semibold"><BookOpen size={20} /> Research & learning</h2>
            <p className="text-sm text-white/60">Only explicit public HTTPS documents. Passages are untrusted evidence, not an AI answer. Review is not a sandbox test.</p></div>
          <button type="button" onClick={onClose} aria-label="Close learning dashboard"><X /></button>
        </header>
        {!admin ? <section className="space-y-2 text-sm"><label className="block">Local owner approval token (kept in memory only)
          <input type="password" autoComplete="off" value={secretInput} onChange={(event) => setSecretInput(event.target.value)} className="ml-2 rounded bg-white/10 p-2" /></label>
          <button type="button" className="rounded bg-cyan-800 p-2" onClick={() => { setAdmin(secretInput); setSecretInput(""); }}>Unlock learning workspace</button>
          <p className="text-amber-200">Protected multi-user mode deliberately locks this legacy owner-only feature. No credentials are stored in the browser.</p></section>
          : <>
            <div className="flex flex-wrap gap-3 text-xs text-white/60"><span>Sandbox: {sandbox}</span><span>Model research role: {modelStatus}</span>
              <button type="button" disabled={busy} className="underline" onClick={() => void act(async () => {
                const result = await request("/api/models/test", "POST", { role: "research", confirm: true });
                setModelStatus(`response received (${result.provider}; ${result.latencyMs} ms; estimated $${result.estimatedCostUsd ?? "unknown"})`);
              }, "Provider connection tested; any response is still an untrusted proposal.")}>Explicitly test provider (may bill)</button>
              <button type="button" className="underline" onClick={() => { void refresh().catch((error) => setNotice(String(error))); }}>Refresh status</button></div>
            <section className="space-y-2 rounded-xl border border-white/10 p-4"><h3 className="font-semibold">1 · Retrieve approved sources</h3>
              <input aria-label="Research question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={300}
                placeholder="Question for source selection, not a claim of fact" className="w-full rounded bg-white/10 p-2" />
              <textarea aria-label="Approved document URLs" value={urls} onChange={(event) => setUrls(event.target.value)} rows={3}
                placeholder="One explicitly approved HTTPS document URL per line (up to five; no queries or login pages)" className="w-full rounded bg-white/10 p-2" />
              <p className="text-xs text-white/50">Robots, redirects, public IPs, document size and rate limits are checked. Network/policy failures yield no source.</p>
              <button type="button" disabled={busy} className="rounded bg-cyan-800 px-3 py-2 disabled:opacity-40" onClick={() => void act(async () => {
                await request("/api/research/tasks", "POST", { question, urls: urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), confirm: true });
              }, "Research queued; wait for source results before drawing a conclusion.")}>Approve exact URLs & start</button>
              {tasks.map((task) => <article key={task.id} className="rounded border border-white/10 p-3 text-sm space-y-2">
                <div className="flex justify-between gap-2"><strong>{task.question} · {task.status}</strong>
                  {!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status) && <button className="text-amber-300 underline" type="button" onClick={() => void act(() => request(`/api/research/tasks/${task.id}/cancel`, "POST"), "Cancellation requested; in-flight provider/network effects may still complete.")}>Cancel</button>}</div>
                <p className="text-xs text-white/50">Findings: {task.findingsStatus}; {task.sources.length} retrieved source(s).</p>
                {task.failures.map((failure) => <p key={failure.url} className="text-amber-200 text-xs break-all">{failure.url}: {failure.reason}</p>)}
                {task.sources.map((source) => <details key={source.id} className="border-l-2 border-cyan-700 pl-3"><summary className="cursor-pointer">{source.title} · {source.status}</summary>
                  <a className="text-cyan-300 underline break-all" href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>
                  <p className="text-xs text-white/60">Retrieved {source.retrievedAt}; source version {source.publishedOrUpdatedAt || "unknown"}; SHA-256 {source.contentHash}</p>
                  {source.passages.map((passage, index) => <p key={index} className="mt-2 text-sm whitespace-pre-wrap">“{passage}”</p>)}</details>)}
              </article>)}
            </section>
            <section className="space-y-2 rounded-xl border border-white/10 p-4"><h3 className="font-semibold">2 · Draft a source-linked entry (human-authored conclusion)</h3>
              <select className="w-full bg-[#131b2c] p-2" value={taskId} onChange={(event) => { setTaskId(event.target.value); setSourceIds([]); }} aria-label="Completed research task">
                <option value="">Select a completed research task</option>{tasks.filter((task) => task.status === "COMPLETED").map((task) => <option key={task.id} value={task.id}>{task.question}</option>)}
              </select>
              {selected?.sources.map((source) => <label className="block text-xs" key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={() => setSourceIds((ids) => ids.includes(source.id) ? ids.filter((id) => id !== source.id) : [...ids, source.id])} /> Use {source.title} · {source.url}</label>)}
              <div className="grid gap-2 sm:grid-cols-2"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" aria-label="Knowledge name" className="rounded bg-white/10 p-2" />
                <select value={kind} onChange={(event) => setKind(event.target.value as "topic" | "skill")} className="rounded bg-[#131b2c] p-2"><option value="topic">Topic (not a skill)</option><option value="skill">Skill proposal, not executable</option></select></div>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Your evidence-based description" aria-label="Description" className="w-full rounded bg-white/10 p-2" />
              <input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Intended use" aria-label="Intended use" className="w-full rounded bg-white/10 p-2" />
              {kind === "skill" && <><textarea value={procedure} onChange={(event) => setProcedure(event.target.value)} placeholder="One reviewed procedure step per line" aria-label="Procedure steps" className="w-full rounded bg-white/10 p-2" />
                <textarea value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="One expected result per line" aria-label="Expected results" className="w-full rounded bg-white/10 p-2" /></>}
              <button type="button" disabled={busy || !selected || !sourceIds.length} className="rounded bg-cyan-800 px-3 py-2 disabled:opacity-40" onClick={() => void act(() => request("/api/knowledge", "POST", {
                researchTaskId: taskId, sourceIds, name, description, intendedUse: purpose, kind, platform: "any", dependencies: [],
                requiredPermissions: [], procedure: kind === "skill" ? procedure.split("\n").filter(Boolean) : [],
                expectedResults: kind === "skill" ? expected.split("\n").filter(Boolean) : [], expiresInDays: 30,
              }), "Proposal saved as pending review; nothing is verified or auto-executed.")}>Save proposed entry</button>
            </section>
            <section className="space-y-2 rounded-xl border border-white/10 p-4"><h3 className="font-semibold">3 · Review, correct & refresh</h3>
              <p className="text-xs text-amber-200">A supported entry is reviewed, not experimentally verified. Skills are not automatically executed. Refresh is opt-in, respects quiet hours and disables changed entries.</p>
              <div className="text-xs flex flex-wrap gap-2 items-center"><label>Refresh interval (hours) <input type="number" min={6} max={720} value={interval} onChange={(event) => setIntervalHours(Number(event.target.value))} className="w-16 rounded bg-white/10 p-1" /></label>
                <label>Quiet from <input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} className="bg-[#131b2c] p-1" /></label>
                <label>until <input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} className="bg-[#131b2c] p-1" /></label><span>Time zone: {timeZone}</span></div>
              {items.map((item) => <article key={item.id} className="rounded border border-white/10 p-3 text-sm space-y-2"><div className="flex flex-wrap gap-2 items-center">
                <strong>{item.name} · v{item.version}</strong><span>{item.kind} · {item.status} · {item.confidence}</span><span className="text-xs">Expires {item.expiresAt}</span></div>
                <p>{item.description}</p><p className="text-xs text-white/60">Intended use: {item.intendedUse}</p>
                {item.evidence.map((evidence, index) => <details key={`${evidence.url}-${index}`} className="text-xs"><summary className="cursor-pointer">Evidence {index + 1}: {evidence.url}</summary><p className="break-all">Retrieved {evidence.retrievedAt}; source SHA-256 {evidence.sourceHash}</p><blockquote className="border-l border-cyan-500 p-2">{evidence.text}</blockquote></details>)}
                <div className="flex flex-wrap gap-3 text-xs text-cyan-300 underline">
                  {item.status === "pending_review" && <button type="button" disabled={busy} onClick={() => {
                    if (window.confirm("I reviewed the source passages. Mark supported, NOT tested or verified?")) void act(() => request(`/api/knowledge/${item.id}/review`, "POST", { confirm: true }), "Marked supported; still not independently tested.");
                  }}>Mark supported</button>}
                  <button type="button" onClick={() => void act(async () => {
                    const reply = await request(`/api/knowledge/${item.id}/history`);
                    setVersions((prev) => ({ ...prev, [item.id]: reply.versions || [] }));
                  }, "Earlier versions loaded; restoring one requires fresh review.")}>History</button>
                  {item.status !== "outdated" && <button type="button" onClick={() => void act(() => request(`/api/knowledge/${item.id}/expire`, "POST"), "Marked outdated; it is not reusable.")}>Mark outdated</button>}
                  {item.status === "supported" && <button type="button" onClick={() => {
                    if (window.confirm("Schedule ONLY this entry's approved source URLs? A bounded refresh may contact these sites later.")) void act(() => request("/api/refresh/plans", "POST", {
                      itemId: item.id, intervalHours: interval, timeZone, quietStart, quietEnd, confirm: true,
                    }), "Refresh scheduled; no automatic skill promotion.");
                  }}>Opt in to refresh</button>}
                  <button type="button" onClick={() => { if (window.confirm(`Permanently delete ${item.name} and all its versions?`)) void act(() => request(`/api/knowledge/${item.id}`, "DELETE"), "Entry and version history deleted."); }}>Delete</button>
                </div>
                {versions[item.id]?.map((version) => <div key={version.version} className="text-xs border-t border-white/10 pt-1">v{version.version}: {version.status} · {version.description}
                  {version.version < item.version && <button type="button" className="ml-2 text-cyan-300 underline" onClick={() => {
                    if (window.confirm(`Restore content from v${version.version} as a NEW pending-review version? Earlier verification will not carry over.`)) void act(() => request(`/api/knowledge/${item.id}/rollback`, "POST", { version: version.version, confirm: true }), "Earlier content restored as an unverified new version.");
                  }}>Restore for review</button>}</div>)}
              </article>)}
              <h4 className="text-sm font-medium">Approved refresh plans</h4>
              {plans.map((plan) => <div key={plan.id} className="rounded bg-white/5 p-2 text-xs">{items.find((item) => item.id === plan.itemId)?.name || plan.itemId} · {plan.enabled ? "enabled" : "disabled"} · every {plan.intervalHours}h · {plan.lastResult || "not checked"}
                <div className="flex gap-3 text-cyan-300 underline">{plan.enabled && <><button type="button" onClick={() => void act(() => request(`/api/refresh/plans/${plan.id}/run`, "POST"), "Refresh requested within quiet-hours and budget rules.")}>Check now</button>
                  <button type="button" onClick={() => void act(() => request(`/api/refresh/plans/${plan.id}/disable`, "POST"), "Refresh disabled; in-flight fetch cancellation requested.")}>Disable</button></>}</div></div>)}
            </section>
            <section className="space-y-3 rounded-xl border border-amber-400/20 p-4 text-sm">
              <h3 className="font-semibold">4 · Isolated skill test and separate human review</h3>
              <p className="text-xs text-amber-200">Only a supported skill plus an intact Python draft can be tested. Docker must be separately enabled with a locally reviewed digest-pinned image. Passing is NOT approval; generated code and tests are untrusted. No production Docker run has been demonstrated here.</p>
              <select aria-label="Supported skill for sandbox test" className="w-full bg-[#131b2c] p-2" value={skillId} onChange={(event) => { setSkillId(event.target.value); setAttemptDetail(null); }}>
                <option value="">Choose a supported skill</option>{items.filter((item) => item.kind === "skill" && item.status === "supported").map((item) =>
                  <option key={item.id} value={item.id}>{item.name} (v{item.version})</option>)}</select>
              <select aria-label="Code artifact for sandbox test" className="w-full bg-[#131b2c] p-2" value={candidateId}
                onChange={(event) => { void inspectCandidate(event.target.value).catch((error) => setNotice(String(error))); }}>
                <option value="">Choose a saved Python draft</option>{codeArtifacts.map((artifact) =>
                  <option key={artifact.id} value={artifact.id}>{artifact.fileName} · SHA-256 {artifact.sha256.slice(0, 12)}</option>)}</select>
              {codePreview && <details open><summary>Candidate source — inspect before running</summary>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-xs">{codePreview}</pre></details>}
              <label className="block">Human-reviewed unittest source (not generated or supplied by a web page)
                <textarea aria-label="Python unittest source" value={testSource} onChange={(event) => setTestSource(event.target.value)}
                  maxLength={30_000} rows={5} className="mt-2 w-full rounded bg-white/10 p-2 font-mono text-xs"
                  placeholder="import unittest; import candidate; class TestCandidate(unittest.TestCase): ..." /></label>
              <button type="button" disabled={busy || !skillId || !codePreview || testSource.length < 20} className="rounded bg-amber-800 px-3 py-2 disabled:opacity-40"
                onClick={() => { if (window.confirm("I inspected the EXACT Python draft and human-authored tests. Run them in my configured disposable Docker sandbox with network disabled? This does not approve a skill.")) void act(() => request("/api/skills/verifications", "POST", {
                  skillId, codeArtifactId: candidateId, testSource, confirm: true,
                }), "Sandbox job started. Wait for evidence; a passing test still requires separate review."); }}>Approve one sandbox test</button>
              {attempts.map((attempt) => <article key={attempt.id} className="rounded border border-white/10 p-2 text-xs">
                <strong>{items.find((item) => item.id === attempt.skillId)?.name || attempt.skillId.slice(0, 8)} · {attempt.status}</strong>
                {attempt.reason && <p className="text-amber-200">{attempt.reason}</p>}
                {attempt.stdout && <details><summary>Test output (untrusted)</summary><pre className="max-h-36 overflow-auto whitespace-pre-wrap">{attempt.stdout}</pre></details>}
                {attempt.stderr && <details><summary>Test diagnostics (untrusted)</summary><pre className="max-h-36 overflow-auto whitespace-pre-wrap">{attempt.stderr}</pre></details>}
                <div className="flex gap-3 text-cyan-300 underline">
                  {(["RUNNING", "CANCEL_REQUESTED"].includes(attempt.status)) && <button type="button" onClick={() => void act(() => request(`/api/skills/verifications/${attempt.id}/cancel`, "POST"), "Container stop requested; inspect the Docker engine before retrying.")}>Cancel test</button>}
                  {attempt.status === "PASSED_AWAITING_REVIEW" && <button type="button" onClick={() => void act(async () => {
                    const detail = await request(`/api/skills/verifications/${attempt.id}`);
                    setAttemptDetail(detail); setReviewedAttempt(false);
                  }, "Inspect the exact code, tests, source evidence, permissions, Docker image and results before approval.")}>Inspect passing evidence</button>}
                </div>
              </article>)}
              {attemptDetail && <article className="space-y-2 rounded border border-amber-400/30 p-3 text-xs">
                <h4 className="font-semibold">Review candidate and test #{attemptDetail.record.id.slice(0, 8)}</h4>
                <p>Skill version {attemptDetail.record.skillVersion}; candidate SHA-256 {attemptDetail.record.codeSha256}; test SHA-256 {attemptDetail.record.testSha256}</p>
                <p>Sandbox image: {attemptDetail.record.evidence?.environment || "unknown"}. Evidence digest: {attemptDetail.record.evidence?.artifactHash || "missing"}.</p>
                <p>Review this skill’s evidence passages and prerequisite permissions in section 3; source text is not permission.</p>
                {attemptDetail.code ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-black/40 p-2">{attemptDetail.code}</pre>
                  : <p className="text-red-300">Code artifact missing or integrity check failed — promotion forbidden.</p>}
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-black/40 p-2">{attemptDetail.record.testSource}</pre>
                <label className="flex gap-2"><input type="checkbox" checked={reviewedAttempt} onChange={(event) => setReviewedAttempt(event.target.checked)} />I reviewed source, tests, behavior, permissions, license and environment; result meets the skill’s stated outcome.</label>
                <button type="button" disabled={busy || !attemptDetail.code || !reviewedAttempt || attemptDetail.record.status !== "PASSED_AWAITING_REVIEW"}
                  className="rounded bg-cyan-800 px-3 py-2 disabled:opacity-40" onClick={() => {
                    if (window.confirm("Promote ONLY this current supported version using its verified Docker test evidence? This does not automatically execute or deploy code.")) void act(async () => {
                      await request(`/api/skills/verifications/${attemptDetail.record.id}/review`, "POST", {
                        confirm: true, codeSha256: attemptDetail.record.codeSha256, testSha256: attemptDetail.record.testSha256,
                        environment: attemptDetail.record.evidence?.environment,
                      }); setAttemptDetail(null); setReviewedAttempt(false);
                    }, "Human-reviewed test evidence linked to a versioned skill; automatic execution remains disabled.");
                  }}>Promote reviewed version</button>
              </article>}
            </section>
          </>}
        {notice && <p role="status" className="rounded border border-amber-500/30 bg-amber-900/20 p-3 text-sm break-words">{notice}</p>}
      </div>
    </div>
  );
}
