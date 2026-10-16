import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { KnowledgeStore, KnowledgeVersion } from "./knowledgeStore";
import type { ResearchJobManager } from "./researchEngine";

export interface RefreshPlan {
  id: string; itemId: string; itemVersion: number; intervalHours: number; timeZone: string;
  quietStart: string; quietEnd: string; enabled: boolean;
  lastCheckedAt?: string; lastResult?: "unchanged" | "changed" | "failed";
  runDates: string[]; taskId?: string; sourceUrls: string[];
}
const HOUR = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function minute(value: string) { const [hour, min] = value.split(":").map(Number); return hour * 60 + min; }
function quiet(plan: RefreshPlan, now: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: plan.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const current = minute(hour), start = minute(plan.quietStart), end = minute(plan.quietEnd);
  return start < end ? current >= start && current < end : start > end && (current >= start || current < end);
}

/** Opt-in refresh only: compare retrieval hashes and flag obsolete knowledge. */
export class RefreshScheduler {
  private readonly plans: RefreshPlan[];
  constructor(private readonly file: string, private readonly knowledge: KnowledgeStore,
    private readonly jobs: ResearchJobManager) {
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Refresh settings cannot be a symlink.");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schema: 1; plans: RefreshPlan[] };
      if (parsed.schema !== 1 || !Array.isArray(parsed.plans) || parsed.plans.length > 20) throw new Error("Refresh settings need manual review.");
      // Old plans without a bound knowledge version must be reapproved; never
      // refresh newly revised content using yesterday's URL consent.
      this.plans = parsed.plans.map((plan) => !Number.isInteger(plan.itemVersion) ? { ...plan, enabled: false } : plan);
    } else this.plans = [];
  }
  list(): RefreshPlan[] { return JSON.parse(JSON.stringify(this.plans)); }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error("Refresh settings cannot be a symlink.");
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schema: 1, plans: this.plans }), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACL review required */ }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  configure(item: KnowledgeVersion, options: { intervalHours: number; timeZone: string;
    quietStart: string; quietEnd: string }): RefreshPlan {
    if (!Number.isInteger(options.intervalHours) || options.intervalHours < 6 || options.intervalHours > 720 ||
        !HOUR.test(options.quietStart) || !HOUR.test(options.quietEnd) || options.quietStart === options.quietEnd ||
        typeof options.timeZone !== "string" || options.timeZone.length > 80 || !item.sourceUrls.length ||
        item.sourceUrls.length > 5 || item.status === "outdated") throw new Error("Invalid bounded refresh schedule or item.");
    try { new Intl.DateTimeFormat("en", { timeZone: options.timeZone }); }
    catch { throw new Error("Invalid refresh time zone."); }
    let plan = this.plans.find((existing) => existing.itemId === item.id);
    if (!plan && this.plans.length >= 20) throw new Error("Too many approved refresh plans.");
    if (plan?.taskId) throw new Error("Wait for the current refresh before reconfiguring.");
    if (!plan) { plan = { id: randomUUID(), itemId: item.id, itemVersion: item.version, intervalHours: options.intervalHours,
      timeZone: options.timeZone, quietStart: options.quietStart, quietEnd: options.quietEnd,
      enabled: true, runDates: [], lastCheckedAt: item.updatedAt, sourceUrls: [...item.sourceUrls] }; this.plans.push(plan); }
    else Object.assign(plan, options, { enabled: true, itemVersion: item.version,
      lastCheckedAt: item.updatedAt, sourceUrls: [...item.sourceUrls] });
    this.save(); return JSON.parse(JSON.stringify(plan));
  }
  disable(id: string): RefreshPlan | undefined {
    const plan = this.plans.find((item) => item.id === id);
    if (!plan) return undefined;
    plan.enabled = false;
    if (plan.taskId) { this.jobs.cancel(plan.taskId); plan.taskId = undefined; }
    this.save(); return JSON.parse(JSON.stringify(plan));
  }
  disableAll() { for (const plan of this.plans) this.disable(plan.id); }
  async trigger(id: string, now = new Date()): Promise<RefreshPlan | undefined> {
    await this.tick(now, id);
    return this.list().find((plan) => plan.id === id);
  }
  async tick(now = new Date(), forceId?: string): Promise<void> {
    for (const plan of this.plans) {
      if (forceId && plan.id !== forceId) continue;
      if (!plan.enabled) continue;
      if (plan.taskId) {
        const job = this.jobs.get(plan.taskId);
        if (!job || ["QUEUED", "FETCHING", "CANCEL_REQUESTED"].includes(job.status)) continue;
        plan.taskId = undefined;
        plan.lastCheckedAt = now.toISOString();
        if (job.status === "COMPLETED" && job.sources.length === plan.sourceUrls.length) {
          const item = this.knowledge.get(plan.itemId);
          if (!item || item.version !== plan.itemVersion) { plan.enabled = false; plan.lastResult = "failed"; }
          else {
            const changed = item.evidence.some((entry) => job.sources.find((source) => source.url === entry.url)?.contentHash !== entry.sourceHash);
            plan.lastResult = changed ? "changed" : "unchanged";
            if (changed) { this.knowledge.expire(plan.itemId); plan.enabled = false; }
          }
        } else plan.lastResult = "failed";
        this.save();
        continue;
      }
      const item = this.knowledge.get(plan.itemId);
      if (!item || item.status === "outdated" || item.version !== plan.itemVersion) {
        plan.enabled = false; plan.lastResult = "failed"; this.save(); continue;
      }
      if (quiet(plan, now) || !forceId && plan.lastCheckedAt &&
          now.getTime() - Date.parse(plan.lastCheckedAt) < plan.intervalHours * 3600_000) continue;
      const day = now.toISOString().slice(0, 10);
      plan.runDates = plan.runDates.filter((date) => date >= new Date(now.getTime() - 86400_000).toISOString().slice(0, 10));
      if (plan.runDates.filter((date) => date === day).length >= 2) continue;
      try {
        const job = this.jobs.submit(`Refresh provenance for: ${item.name}`, plan.sourceUrls);
        plan.taskId = job.id; plan.runDates.push(day); this.save();
      } catch { /* An active user task or unavailable host never triggers an unbounded retry. */ }
      break; // at most one refresh dispatch per tick; the job manager serializes work.
    }
  }
}
