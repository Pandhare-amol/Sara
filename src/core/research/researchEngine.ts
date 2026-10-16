import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchPublicUrl, type SafeRemoteFetchOptions, type SafeRemoteResponse } from "../../security/safeRemoteFetch";

export type ResearchStatus = "QUEUED" | "FETCHING" | "CANCEL_REQUESTED" | "CANCELLED" | "COMPLETED" | "FAILED";
export interface SourceRecord {
  id: string; url: string; title: string; retrievedAt: string;
  publishedOrUpdatedAt?: string; contentHash: string; passages: string[];
  status: "retrieved_unverified"; sourceType: "web_document";
}
export interface ResearchJob {
  id: string; question: string; urls: string[]; status: ResearchStatus;
  sources: SourceRecord[]; failures: Array<{ url: string; reason: string }>;
  startedAt?: string; finishedAt?: string;
  findingsStatus: "unresolved"; // Source text, not an independently verified answer.
}
type Fetcher = (url: string, options: SafeRemoteFetchOptions) => Promise<SafeRemoteResponse>;
const AGENT = "SARA-Research";
const MAX_SOURCES = 5;
const SENSITIVE = /\b(?:password|passphrase|api[_ -]?key|bearer|access[_ -]?token|secret|private key)\s*[:=]\s*\S+/gi;
const TERMS = /[\p{L}\p{N}]{3,}/gu;

function safeUrl(input: string): URL {
  if (typeof input !== "string" || input.length > 1500) throw new Error("URL is too long.");
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)) {
    throw new Error("Use an explicit HTTPS document URL without credentials, query, fragment or custom port.");
  }
  return url;
}
function text(value: string, max = 1600): string {
  return value.replace(SENSITIVE, "[redacted]").replace(/\s+/g, " ").trim().slice(0, max);
}
function decodeEntities(input: string): string {
  return input.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(?:x[0-9a-f]{1,6}|[0-9]{1,7}));/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : " ";
  });
}
function extract(body: Buffer, type: string, question: string): { title: string; passages: string[]; version?: string; digest: string } {
  const raw = body.toString("utf8");
  const html = type.includes("html");
  const title = html ? text(decodeEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "Untitled page"), 150) : "Plain-text document";
  const date = html ? raw.match(/<meta\s+[^>]*?(?:name|property)=["'](?:article:published_time|article:modified_time|date|last-modified)["'][^>]*?content=["']([^"']{1,80})/i)?.[1] : undefined;
  const stripped = html ? raw.replace(/<(script|style|form|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|li|section|article|h[1-6]|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ") : raw;
  const lines = decodeEntities(stripped).split(/[\n.!?]+/).map((line) => text(line, 400))
    .filter((line) => line.length >= 25 && line !== "[redacted]");
  const words = new Set((question.toLowerCase().match(TERMS) || []).filter((term) => term.length > 3));
  const ranked = lines.map((line, index) => ({ line, index,
    score: (line.toLowerCase().match(TERMS) || []).filter((word) => words.has(word)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5).sort((a, b) => a.index - b.index);
  return { title, passages: ranked.map((item) => item.line), version: date ? text(date, 80) : undefined,
    digest: createHash("sha256").update(body).digest("hex") };
}

interface RobotRule { path: string; allow: boolean }
function rulesFor(robots: string, userAgent = AGENT): { rules: RobotRule[]; delaySeconds: number } {
  let names: string[] = []; let hasDirectives = false;
  const groups: Array<{ names: string[]; rules: RobotRule[]; delaySeconds: number }> = [];
  for (const original of robots.split(/\r?\n/)) {
    const line = original.split("#")[0].trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const [, key, value] = match;
    if (key.toLowerCase() === "user-agent") {
      if (hasDirectives) { names = []; hasDirectives = false; }
      names.push(value.toLowerCase());
      continue;
    }
    if (!names.length) continue;
    hasDirectives = true;
    let group = groups.at(-1);
    if (!group || group.names !== names) { group = { names, rules: [], delaySeconds: 0 }; groups.push(group); }
    if (/^(allow|disallow)$/i.test(key) && value.startsWith("/")) group.rules.push({ path: value, allow: key.toLowerCase() === "allow" });
    if (key.toLowerCase() === "crawl-delay" && Number.isFinite(Number(value)) && Number(value) >= 0) {
      group.delaySeconds = Math.max(group.delaySeconds, Number(value));
    }
  }
  const specific = groups.filter((group) => group.names.some((name) => userAgent.toLowerCase().includes(name) && name !== "*"));
  const matched = specific.length ? specific : groups.filter((group) => group.names.includes("*"));
  return { rules: matched.flatMap((group) => group.rules),
    delaySeconds: Math.max(0, ...matched.map((group) => group.delaySeconds)) };
}
export function robotsPermit(robots: string, pathname: string): { allowed: boolean; delaySeconds: number } {
  const { rules, delaySeconds } = rulesFor(robots);
  const applicable = rules.filter((rule) => {
    const anchor = rule.path.endsWith("$");
    const regex = new RegExp("^" + rule.path.replace(/\$$/, "").split("*").map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchor ? "$" : ""));
    return regex.test(pathname);
  }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return { allowed: !applicable.length || applicable[0].allow, delaySeconds };
}

/** Explicit URLs only; no broad crawler, login, bypass or model-claimed sources. */
export class ResearchEngine {
  constructor(private readonly fetcher: Fetcher = fetchPublicUrl) {}

  async collect(question: string, approvedUrls: string[], signal: AbortSignal,
    progress: (update: { status: ResearchStatus; source?: SourceRecord; failure?: { url: string; reason: string } }) => void): Promise<void> {
    if (!question.trim() || question.length > 4000 || !Array.isArray(approvedUrls) ||
        approvedUrls.length < 1 || approvedUrls.length > MAX_SOURCES) throw new Error("Approve a question and 1–5 document URLs.");
    const urls = approvedUrls.map(safeUrl);
    if (new Set(urls.map((url) => url.href)).size !== urls.length) throw new Error("Duplicate document URLs are not allowed.");
    const robots = new Map<string, string>();
    const lastFetch = new Map<string, number>();
    for (const url of urls) {
      if (signal.aborted) throw new Error("Research cancelled.");
      progress({ status: "FETCHING" });
      try {
        if (!robots.has(url.origin)) {
          const policy = await this.fetcher(`${url.origin}/robots.txt`, { allowedOrigins: [url.origin],
            maxBytes: 64_000, maxRedirects: 1, timeoutMs: 7_000, signal });
          if (policy.statusCode === 404 || policy.statusCode === 410) robots.set(url.origin, "");
          else if (policy.statusCode === 200 && String(policy.headers["content-type"] || "").toLowerCase().startsWith("text/plain")) {
            robots.set(url.origin, policy.body.toString("utf8"));
          } else throw new Error("Robots policy unavailable or access is denied.");
        }
        const decision = robotsPermit(robots.get(url.origin) || "", url.pathname);
        if (!decision.allowed) throw new Error("Robots policy disallows this page.");
        if (decision.delaySeconds > 30) throw new Error("Crawl delay exceeds this bounded research session.");
        const gap = Math.max(1, decision.delaySeconds) * 1000 - (Date.now() - (lastFetch.get(url.origin) || 0));
        if (gap > 0) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, gap);
          const stop = () => { clearTimeout(timer); reject(new Error("Research cancelled.")); };
          signal.addEventListener("abort", stop, { once: true });
        });
        if (signal.aborted) throw new Error("Research cancelled.");
        const githubReadme = url.hostname === "api.github.com" && /^\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/readme$/i.test(url.pathname);
        const page = await this.fetcher(url.href, { allowedOrigins: [url.origin], maxBytes: 192_000,
          maxRedirects: 2, timeoutMs: 9_000, signal, headers: { Accept: githubReadme ? "application/vnd.github+json" : "text/html,text/plain,text/markdown" } });
        lastFetch.set(url.origin, Date.now());
        if (page.statusCode !== 200) throw new Error(`Document returned HTTP ${page.statusCode}.`);
        const type = String(page.headers["content-type"] || "").toLowerCase();
        let readable = page.body;
        let sourceVersion: string | undefined;
        let sourceTitle: string | undefined;
        if (githubReadme && type.includes("json")) {
          const document = JSON.parse(page.body.toString("utf8")) as { encoding?: string; content?: string; sha?: string; name?: string };
          if (document.encoding !== "base64" || typeof document.content !== "string" ||
              document.content.length > 140_000 || !/^[a-zA-Z0-9+/\s=]+$/.test(document.content) ||
              !/^[a-f0-9]{40}$/.test(document.sha || "") || !/\.md$/i.test(document.name || "")) {
            throw new Error("GitHub README did not contain bounded, supported text.");
          }
          readable = Buffer.from(document.content.replace(/\s/g, ""), "base64");
          if (readable.length > 100_000) throw new Error("GitHub README exceeded the research size limit.");
          sourceVersion = document.sha;
          sourceTitle = `${url.pathname.slice(7, -7)} / ${document.name}`;
        } else if (!/^(text\/html|text\/plain|text\/markdown)(?:[;\s]|$)/.test(type)) {
          throw new Error("Non-text document; no extraction performed.");
        }
        const sourceUrl = safeUrl(page.finalUrl);
        const source = extract(readable, githubReadme ? "text/markdown" : type, question);
        if (!source.passages.length) throw new Error("No substantial readable passages were found.");
        progress({ status: "FETCHING", source: { id: randomUUID(), url: sourceUrl.href, title: sourceTitle || source.title,
          retrievedAt: new Date().toISOString(), publishedOrUpdatedAt: sourceVersion || source.version,
          contentHash: source.digest, passages: source.passages,
          status: "retrieved_unverified", sourceType: "web_document" } });
      } catch (error) {
        if (signal.aborted) throw new Error("Research cancelled.");
        progress({ status: "FETCHING", failure: { url: url.href,
          reason: error instanceof Error && /Robots|disallows|Non-text|HTTP \d+|No substantial|Crawl delay/.test(error.message)
            ? error.message : "Source unavailable or blocked; check permissions and network policy." } });
      }
    }
  }
}

export class ResearchJobManager {
  private readonly jobs = new Map<string, ResearchJob>();
  private readonly dailyUsage: Array<{ day: string; origins: string[] }> = [];
  private active: { id: string; abort: AbortController } | null = null;
  constructor(private readonly engine: ResearchEngine = new ResearchEngine(), private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Research history cannot be a symlink.");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schema: 1; jobs: ResearchJob[];
        dailyUsage?: Array<{ day: string; origins: string[] }> };
      if (parsed.schema !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > 40 ||
          parsed.dailyUsage && (!Array.isArray(parsed.dailyUsage) || parsed.dailyUsage.length > 200 ||
            parsed.dailyUsage.some((entry) => !/^\d{4}-\d\d-\d\d$/.test(entry.day) || !Array.isArray(entry.origins) || entry.origins.length > 5))) {
        throw new Error("Research history needs manual recovery.");
      }
      this.dailyUsage.push(...(parsed.dailyUsage || []));
      for (const item of parsed.jobs) this.jobs.set(item.id, {
        ...item, status: ["QUEUED", "FETCHING", "CANCEL_REQUESTED"].includes(item.status) ? "CANCELLED" : item.status,
        finishedAt: item.finishedAt || new Date().toISOString(),
      });
    }
  }
  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error("Research history cannot be a symlink.");
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schema: 1, jobs: [...this.jobs.values()], dailyUsage: this.dailyUsage }), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACL review required */ }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }

  submit(question: string, urls: string[]): ResearchJob {
    if (this.active || this.jobs.size >= 40) throw new Error("Research queue is full; finish or delete a task first.");
    if (typeof question !== "string" || question.trim().length < 2 || question.length > 4000 ||
        !Array.isArray(urls) || urls.length < 1 || urls.length > MAX_SOURCES) throw new Error("Approve 1–5 URLs and a bounded question.");
    const checked = urls.map(safeUrl);
    if (new Set(checked.map((url) => url.href)).size !== checked.length) throw new Error("Duplicate document URLs are not allowed.");
    const today = new Date().toISOString().slice(0, 10);
    const prior = this.dailyUsage.filter((entry) => entry.day === today);
    if (prior.length >= 20 || prior.reduce((count, entry) => count + entry.origins.length, 0) + checked.length > 30 ||
        checked.some((url) => prior.flatMap((entry) => entry.origins).filter((origin) => origin === url.origin).length +
          checked.filter((item) => item.origin === url.origin).length > 10)) {
      throw new Error("Daily research request/host budget exhausted. Try tomorrow or ask the owner to review policy.");
    }
    const job: ResearchJob = { id: randomUUID(), question: text(question, 4000), urls: [...urls],
      status: "QUEUED", sources: [], failures: [], findingsStatus: "unresolved" };
    this.jobs.set(job.id, job);
    this.dailyUsage.push({ day: today, origins: checked.map((url) => url.origin) });
    for (let index = this.dailyUsage.length - 1; index >= 0; index--) {
      if (this.dailyUsage[index].day < new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)) this.dailyUsage.splice(index, 1);
    }
    try { this.save(); } catch (error) { this.jobs.delete(job.id); this.dailyUsage.pop(); throw error; }
    const abort = new AbortController();
    this.active = { id: job.id, abort };
    void this.engine.collect(job.question, job.urls, abort.signal, (update) => {
      if (abort.signal.aborted) return;
      job.status = update.status;
      if (update.source) job.sources.push(update.source);
      if (update.failure) job.failures.push(update.failure);
      job.startedAt ||= new Date().toISOString();
      this.save();
    }).then(() => { job.status = abort.signal.aborted ? "CANCELLED" : job.sources.length ? "COMPLETED" : "FAILED"; },
      () => { job.status = abort.signal.aborted ? "CANCELLED" : "FAILED"; })
      .finally(() => { job.finishedAt = new Date().toISOString(); if (this.active?.id === job.id) this.active = null;
        try { this.save(); } catch {
          job.status = "FAILED";
          job.failures.push({ url: "", reason: "Research checkpoint could not be saved; do not treat it as durable." });
        }
      });
    return this.get(job.id)!;
  }
  get(id: string): ResearchJob | undefined {
    const job = this.jobs.get(id);
    return job ? JSON.parse(JSON.stringify(job)) as ResearchJob : undefined;
  }
  list(): ResearchJob[] { return [...this.jobs.values()].map((job) => this.get(job.id)!).slice(-40); }
  cancel(id: string): ResearchJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (this.active?.id === id) { job.status = "CANCEL_REQUESTED"; this.active.abort.abort(); this.save(); }
    return this.get(id);
  }
  delete(id: string): boolean {
    if (this.active?.id === id) { this.cancel(id); return false; }
    const deleted = this.jobs.delete(id);
    if (deleted) this.save();
    return deleted;
  }
  stopAll(): void { if (this.active) this.cancel(this.active.id); }
}
