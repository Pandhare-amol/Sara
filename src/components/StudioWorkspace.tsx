import { useEffect, useRef, useState } from "react";
import { Download, Sparkles, X } from "lucide-react";

type Modality = "text" | "image" | "image-edit" | "narration" | "tone-sequence" | "document" | "code" | "storyboard" | "3d-primitive" | "video-assembly";
type Format = "md" | "txt" | "csv" | "png" | "wav" | "pdf" | "py" | "obj" | "mp4" | "docx" | "xlsx" | "pptx";
type Capability = { modality: string; configured: boolean; connection: string;
  generated: number; failed: number; lastLatencyMs?: number; limitations?: string };
type Job = { id: string; status: string; request: { prompt: string; modality: Modality };
  artifactId?: string; error?: string };
type Artifact = { id: string; fileName: string; kind: string; format: Format; parentId?: string;
  bytes: number; createdAt: string; verification: string[]; provider: string; model: string;
  prompt: string; estimatedCostUsd?: number; dimensions?: { width: number; height: number }; durationSeconds?: number;
  geometry?: { vertices: number; triangles: number } };
const FORMATS: Record<Modality, Format[]> = { text: ["md", "txt"], image: ["png"], "image-edit": ["png"], narration: ["wav"], "tone-sequence": ["wav"],
  document: ["md", "pdf", "csv"], code: ["py"], storyboard: ["md"], "3d-primitive": ["obj"], "video-assembly": ["mp4"] };
const MODALITIES: Modality[] = ["text", "image", "image-edit", "narration", "tone-sequence", "document", "code", "storyboard", "3d-primitive", "video-assembly"];

/** Local owner-only generation: never put provider secrets or artifact paths in the browser. */
export function StudioWorkspace({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [secretInput, setSecretInput] = useState(""); const [admin, setAdmin] = useState("");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [budget, setBudget] = useState<{ estimatedReservedUsd: number; dailyLimitUsd: number } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]); const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [modality, setModality] = useState<Modality>("text"); const [format, setFormat] = useState<Format>("md");
  const [prompt, setPrompt] = useState(""); const [aspectRatio, setAspectRatio] = useState("1:1");
  const [voice, setVoice] = useState("nova"); const [parentId, setParentId] = useState("");
  const [shape, setShape] = useState<"cube" | "sphere" | "cylinder">("cube");
  const [width, setWidth] = useState(1); const [height, setHeight] = useState(1); const [depth, setDepth] = useState(1);
  const [videoImages, setVideoImages] = useState<string[]>([]);
  const [videoAudio, setVideoAudio] = useState(""); const [secondsPerImage, setSecondsPerImage] = useState(3);
  const [bpm, setBpm] = useState(120);
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [previewText, setPreviewText] = useState(""); const [previewUrl, setPreviewUrl] = useState("");
  const [previewType, setPreviewType] = useState<"image" | "audio" | "video" | "">("");
  const mediaUrl = useRef("");
  const clearPreview = () => { if (mediaUrl.current) URL.revokeObjectURL(mediaUrl.current);
    mediaUrl.current = ""; setPreviewText(""); setPreviewUrl(""); setPreviewType(""); };
  const request = async (route: string, method = "GET", data?: unknown): Promise<Response> => {
    const response = await fetch(route, { method, mode: "same-origin", redirect: "error", cache: "no-store",
      headers: { "X-Admin-Token": admin, ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Studio request denied (${response.status}).`);
    }
    return response;
  };
  const json = async (route: string, method = "GET", data?: unknown) => (await request(route, method, data)).json();
  const refresh = async () => {
    const [status, taskList, history] = await Promise.all([json("/api/studio/capabilities"),
      json("/api/studio/jobs"), json("/api/studio/artifacts")]);
    setCapabilities(status.capabilities || []); setBudget(status.budget || null);
    setJobs(taskList.jobs || []); setArtifacts(history.artifacts || []);
  };
  useEffect(() => {
    if (!isOpen || !admin) return;
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "Workspace unavailable."));
    const timer = window.setInterval(() => { void refresh().catch(() => { /* Never interpret a missed poll as completion. */ }); }, 2500);
    return () => window.clearInterval(timer);
  }, [isOpen, admin]);
  useEffect(() => {
    if (!isOpen) { clearPreview(); setAdmin(""); setSecretInput(""); setPrompt("");
      setJobs([]); setArtifacts([]); setCapabilities([]); setParentId(""); }
    return () => { if (mediaUrl.current) URL.revokeObjectURL(mediaUrl.current); };
  }, [isOpen]);
  const act = async (work: () => Promise<void>, message: string) => {
    setBusy(true); setNotice("");
    try { await work(); await refresh(); setNotice(message); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Operation was not verified."); }
    finally { setBusy(false); }
  };
  const inspect = async (artifact: Artifact, download: boolean) => {
    setNotice("");
    try {
      const response = await request(`/api/studio/artifacts/${artifact.id}/download`);
      const blob = await response.blob();
      if (download) {
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = artifact.fileName; document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setNotice("Verified artifact download requested; check the browser before claiming it was saved elsewhere.");
      } else if (["txt", "md", "py", "csv", "obj"].includes(artifact.format)) {
        clearPreview(); setPreviewText((await blob.text()).slice(0, 12_000));
      } else if (["png", "wav", "mp4"].includes(artifact.format)) {
        clearPreview(); mediaUrl.current = URL.createObjectURL(blob);
        setPreviewUrl(mediaUrl.current); setPreviewType(artifact.format === "png" ? "image" : artifact.format === "wav" ? "audio" : "video");
      } else setNotice("Use Download to open PDF in your browser's PDF viewer.");
    } catch (error) { clearPreview(); setNotice(error instanceof Error ? error.message : "Artifact not readable."); }
  };
  const switchModality = (next: Modality) => { setModality(next); setFormat(FORMATS[next][0]); setParentId(""); clearPreview(); };
  const ready = capabilities.find((entry) => entry.modality === modality);
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/85 p-2 sm:p-8" role="dialog" aria-modal="true" aria-label="Creative studio workspace">
    <div className="w-full max-w-5xl max-h-full overflow-y-auto rounded-2xl border border-fuchsia-400/25 bg-[#100d19] p-4 sm:p-7 text-white shadow-2xl space-y-5 select-text">
      <header className="flex justify-between gap-3"><div><h2 className="flex items-center gap-2 text-xl font-semibold"><Sparkles size={20} /> Create · private artifact workspace</h2>
        <p className="text-sm text-white/60">Only validated, saved files appear as completed. Generation uses approved backend providers and may bill. Text and code remain unverified content.</p></div>
        <button type="button" aria-label="Close studio" onClick={onClose}><X /></button></header>
      {!admin ? <section className="space-y-2 text-sm"><label className="block">Local owner approval token (memory only)
        <input type="password" autoComplete="off" value={secretInput} onChange={(event) => setSecretInput(event.target.value)} className="ml-2 rounded bg-white/10 p-2" /></label>
        <button type="button" className="rounded bg-fuchsia-800 p-2" onClick={() => { setAdmin(secretInput); setSecretInput(""); }}>Unlock creative workspace</button>
        <p className="text-amber-200">Protected multi-user mode intentionally locks this owner-only feature; there is no cross-user sharing.</p></section> : <>
        <section className="rounded-xl border border-white/10 p-4 space-y-2"><h3 className="font-semibold">1 · Choose a capability and describe your work</h3>
          <div className="flex flex-wrap gap-2">{MODALITIES.map((choice) => <button key={choice} type="button" onClick={() => switchModality(choice)}
            className={`rounded px-2 py-1 text-xs ${choice === modality ? "bg-fuchsia-700" : "bg-white/10"}`}>{choice}</button>)}</div>
          <div className="text-sm text-white/60">{ready ? `${ready.configured ? "Configured, not guaranteed available" : "Not configured"} · connection ${ready.connection} · ${ready.generated} saved / ${ready.failed} failed` : "Checking provider status…"}</div>
          <textarea aria-label="Creation request" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={4}
            placeholder={modality === "storyboard" ? "Describe scenes for a Markdown storyboard (not a video)" :
              modality === "tone-sequence" ? "Enter actual notes: C4:1 D4:1 E4:2 R:1 F#4:2 (not AI-composed music)" :
              modality === "video-assembly" ? "Describe this cut-only slide montage for its private file history" :
              "Give a precise description; no source/reference files are uploaded"}
            className="w-full rounded bg-white/10 p-2" />
          <div className="flex flex-wrap items-center gap-3 text-sm"><label>File type <select value={format} onChange={(event) => setFormat(event.target.value as Format)} className="ml-2 bg-[#21172d] p-1">
            {FORMATS[modality].map((entry) => <option key={entry} value={entry}>.{entry}</option>)}
          </select></label>
            {modality === "image-edit" && <label>Private PNG reference to send to OpenAI <select value={parentId} onChange={(event) => setParentId(event.target.value)} className="ml-2 max-w-56 bg-[#21172d] p-1">
              <option value="">Select reference (required)</option>{artifacts.filter((artifact) => artifact.kind === "image" && artifact.format === "png")
                .map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.fileName}</option>)}</select></label>}
            {modality === "image" && <label>Aspect ratio <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} className="ml-2 bg-[#21172d] p-1">
              {["1:1", "3:4", "4:3", "9:16", "16:9"].map((entry) => <option key={entry}>{entry}</option>)}</select></label>}
            {modality === "tone-sequence" && <label>Tempo (BPM) <input type="number" min={40} max={180} step={1} value={bpm}
              onChange={(event) => setBpm(Number(event.target.value))} className="ml-2 w-16 rounded bg-white/10 p-1" /></label>}
            {modality === "narration" && <label>Synthetic voice <select value={voice} onChange={(event) => setVoice(event.target.value)} className="ml-2 bg-[#21172d] p-1">
              {["nova", "alloy", "echo", "fable", "onyx", "shimmer"].map((entry) => <option key={entry}>{entry}</option>)}</select></label>}
            {modality === "video-assembly" && <div className="w-full space-y-2 rounded border border-white/10 p-2 text-xs">
              <p>Select 1–5 previously saved PNG files in order. This makes a cut-only local video, not prompt-to-video generation. Requires owner-reviewed FFmpeg.</p>
              {artifacts.filter((artifact) => artifact.kind === "image" && artifact.format === "png").map((artifact) =>
                <label key={artifact.id} className="block"><input type="checkbox" checked={videoImages.includes(artifact.id)}
                  onChange={() => setVideoImages((ids) => ids.includes(artifact.id) ? ids.filter((id) => id !== artifact.id) : ids.length < 5 ? [...ids, artifact.id] : ids)} /> {artifact.fileName}</label>)}
              <p>Order selected: {videoImages.map((id) => artifacts.find((item) => item.id === id)?.fileName || id).join(" → ") || "none"}</p>
              <label>Seconds per image <input type="number" min={1} max={6} step={1} value={secondsPerImage} onChange={(event) => setSecondsPerImage(Number(event.target.value))}
                className="ml-2 w-16 rounded bg-white/10 p-1" /></label>
              <label className="ml-3">Optional saved WAV audio <select value={videoAudio} onChange={(event) => setVideoAudio(event.target.value)} className="ml-2 bg-[#21172d] p-1">
                <option value="">No audio</option>{artifacts.filter((artifact) => ["narration", "tone"].includes(artifact.kind) && artifact.format === "wav").map((artifact) =>
                  <option key={artifact.id} value={artifact.id}>{artifact.fileName}</option>)}
              </select></label>
            </div>}
            {modality === "3d-primitive" && <><label>Shape <select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)} className="ml-2 bg-[#21172d] p-1">
              {["cube", "sphere", "cylinder"].map((entry) => <option key={entry}>{entry}</option>)}</select></label>
              {([["Width", width, setWidth], ["Height", height, setHeight], ["Depth", depth, setDepth]] as const).map(([label, value, change]) =>
                <label key={label}>{label} (m) <input type="number" min={0.1} max={10} step={0.1} value={value} onChange={(event) => change(Number(event.target.value))}
                  className="ml-1 w-16 rounded bg-white/10 p-1" /></label>)}</>}
            {["text", "document", "code", "storyboard"].includes(modality) && <label>Revise existing draft <select value={parentId} onChange={(event) => setParentId(event.target.value)} className="ml-2 max-w-40 bg-[#21172d] p-1">
              <option value="">Create new</option>{artifacts.filter((artifact) => modality === "code" ? artifact.kind === "code" : ["text", "document"].includes(artifact.kind))
                .map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.fileName}</option>)}</select></label>}</div>
          <p className="text-xs text-white/50">No personal-file uploads or voice cloning. Image editing sends a chosen saved PNG to OpenAI only after consent. The offline tone sequencer plays YOUR note list; it is not AI music production. Prompt-to-video footage and rigged 3D are unavailable. MP4 assembly uses saved images; a storyboard alone is never a video.</p>
          <button type="button" disabled={!ready?.configured || busy || prompt.trim().length < 2 ||
            modality === "video-assembly" && !videoImages.length || modality === "image-edit" && !parentId}
            className="rounded bg-fuchsia-800 px-3 py-2 text-sm disabled:opacity-40" onClick={() => {
            if (modality === "image-edit" && !window.confirm("Send this exact saved reference PNG to the configured OpenAI image-edit endpoint? It may incur charges. The original remains stored separately.")) return;
            void act(async () => {
            await json("/api/studio/jobs", "POST", { modality, format, prompt, aspectRatio: modality === "image" ? aspectRatio : undefined,
              voice: modality === "narration" ? voice : undefined,
              bpm: modality === "tone-sequence" ? bpm : undefined,
              shape: modality === "3d-primitive" ? shape : undefined,
              dimensions: modality === "3d-primitive" ? { width, height, depth } : undefined,
              video: modality === "video-assembly" ? { imageIds: videoImages, narrationId: videoAudio || undefined, secondsPerImage } : undefined,
              parentId: parentId || undefined, confirmReference: modality === "image-edit", confirm: true });
            }, "Provider request queued. A file is not saved until status becomes COMPLETED.");
          }}>Approve provider request & create</button>
          {budget && <p className="text-xs text-amber-200">Media estimated reservations: ${budget.estimatedReservedUsd.toFixed(4)} / ${budget.dailyLimitUsd.toFixed(2)} UTC day. Actual billing may differ; failed calls may bill. Text uses the separate router budget.</p>}
        </section>
        <section className="rounded-xl border border-white/10 p-4 space-y-2"><h3 className="font-semibold">2 · Progress & cancellation</h3>
          {!jobs.length && <p className="text-sm text-white/50">No generations submitted in this process.</p>}
          {jobs.map((job) => <div className="rounded bg-white/5 p-2 text-sm" key={job.id}>
            <strong>{job.request.modality} · {job.status}</strong> <span className="text-white/60">{job.request.prompt.slice(0, 100)}</span>
            {job.error && <p className="text-amber-200">{job.error}</p>}
            {job.artifactId && <p className="text-emerald-300">Verified file ID: {job.artifactId}</p>}
            {["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status) && <button type="button" className="ml-2 text-amber-300 underline"
              onClick={() => void act(() => json(`/api/studio/jobs/${job.id}/cancel`, "POST").then(() => {}), "Cancellation requested; remote billing may still occur.")}>Cancel this creation</button>}
          </div>)}
        </section>
        <section className="rounded-xl border border-white/10 p-4 space-y-2"><h3 className="font-semibold">3 · Saved files, revisions & export</h3>
          {!artifacts.length && <p className="text-sm text-white/50">No verified saved artifacts. A provider response alone is not a file.</p>}
          {artifacts.map((artifact) => <article key={artifact.id} className="rounded border border-white/10 p-3 text-sm space-y-1">
            <div><strong>{artifact.fileName}</strong> · {artifact.bytes} bytes · {artifact.provider}/{artifact.model}
              {artifact.parentId && <span> · revision of {artifact.parentId.slice(0, 8)}</span>}</div>
            <p className="text-xs text-white/60">{artifact.createdAt} · checks: {artifact.verification.join(", ")}
              {artifact.dimensions && ` · ${artifact.dimensions.width}×${artifact.dimensions.height}`}
              {artifact.durationSeconds && ` · ${artifact.durationSeconds.toFixed(1)} s`}
              {artifact.geometry && ` · ${artifact.geometry.vertices} vertices / ${artifact.geometry.triangles} triangles`}
              {artifact.estimatedCostUsd !== undefined && ` · estimated $${artifact.estimatedCostUsd.toFixed(4)}`}</p>
            <p className="text-xs text-white/50">Request: {artifact.prompt.slice(0, 180)}</p>
            <div className="flex flex-wrap gap-3 text-xs text-fuchsia-300 underline">
              <button type="button" onClick={() => { void inspect(artifact, false); }}>Preview</button>
              <button type="button" onClick={() => { void inspect(artifact, true); }}><Download size={12} className="inline" /> Download</button>
              {["md", "txt"].includes(artifact.format) && <button type="button" onClick={() => void act(async () => {
                await json(`/api/studio/artifacts/${artifact.id}/export-pdf`, "POST", { confirm: true });
              }, "New PDF exported and reopened locally; factual content is not independently checked.")}>Export as PDF (Latin text)</button>}
              {((["md", "txt"].includes(artifact.format) ? ["docx", "pptx"] : artifact.format === "csv" ? ["xlsx"] : []) as Array<"docx" | "pptx" | "xlsx">).map((type) =>
                <button key={type} type="button" onClick={() => void act(async () => {
                  await json(`/api/studio/artifacts/${artifact.id}/export-office`, "POST", { format: type, confirm: true });
                }, `New ${type.toUpperCase()} validated as an OOXML package; native Office rendering still requires a device check.`)}>Export as {type.toUpperCase()}</button>)}
              <button type="button" className="text-red-300" onClick={() => {
                if (window.confirm(`Permanently delete ${artifact.fileName}? Existing revisions remain separate.`)) void act(async () => {
                  await json(`/api/studio/artifacts/${artifact.id}`, "DELETE", { confirm: true }); clearPreview();
                }, "Selected artifact deletion confirmed.");
              }}>Delete file</button>
            </div>
          </article>)}
          {previewText && <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-3 text-xs">{previewText}</pre>}
          {previewType === "image" && previewUrl && <img src={previewUrl} alt="Selected generated image preview" className="max-h-72 rounded object-contain" />}
          {previewType === "audio" && previewUrl && <audio controls src={previewUrl} aria-label="Selected generated narration" />}
          {previewType === "video" && previewUrl && <video controls src={previewUrl} aria-label="Selected locally assembled video" className="max-h-72 max-w-full" />}
        </section>
        <footer className="text-xs text-white/50">Unsupported: generated moving footage, music production, textured/rigged/animated 3D, native Office editing without the installed Windows Office agent, arbitrary reference-file uploads and personal voice imitation. Local DOCX/XLSX/PPTX exports were checked as OOXML files, not opened in Microsoft Office on this host. Provider image edits require reference consent; local MP4 assembly requires reviewed FFmpeg and saved PNG files. OBJ can be imported elsewhere, but Blender was not tested. Python code is an unexecuted draft, not a deployed application.</footer>
      </>}
      {notice && <p role="status" className="rounded border border-amber-500/30 bg-amber-900/20 p-3 text-sm break-words">{notice}</p>}
    </div>
  </div>;
}
