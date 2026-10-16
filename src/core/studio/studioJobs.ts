import { randomUUID } from "node:crypto";
import type { GenerationGateway, StudioRequest } from "./generationGateway";

export interface StudioJob {
  id: string; status: "QUEUED" | "RUNNING" | "CANCEL_REQUESTED" | "COMPLETED" | "FAILED" | "CANCELLED";
  request: StudioRequest; startedAt: string; completedAt?: string;
  artifactId?: string; error?: string;
}

/** Bounded, asynchronous, cancellable jobs so chat remains responsive. */
export class StudioJobs {
  private readonly jobs = new Map<string, StudioJob>();
  private readonly controllers = new Map<string, AbortController>();
  private active = 0;
  constructor(private readonly gateway: Pick<GenerationGateway, "generate">, private readonly maxConcurrent = 1) {}
  list(): StudioJob[] { return [...this.jobs.values()].map((item) => structuredClone(item)).reverse(); }
  get(id: string): StudioJob | undefined { const item = this.jobs.get(id); return item ? structuredClone(item) : undefined; }
  submit(request: StudioRequest): StudioJob {
    if (this.active >= this.maxConcurrent) throw new Error("Studio busy; wait for the current generation to finish.");
    if (this.jobs.size >= 100) throw new Error("Studio session job history is full; restart after saving artifacts.");
    const job: StudioJob = { id: randomUUID(), status: "QUEUED", request, startedAt: new Date().toISOString() };
    const controller = new AbortController(); this.jobs.set(job.id, job); this.controllers.set(job.id, controller);
    this.active++;
    setImmediate(() => { void this.run(job, controller); });
    return structuredClone(job);
  }
  private async run(job: StudioJob, controller: AbortController) {
    try {
      if (controller.signal.aborted) { job.status = "CANCELLED"; return; }
      job.status = "RUNNING";
      const artifact = await this.gateway.generate(job.request, controller.signal);
      // A completed disk write cannot be undone by a late cancellation.
      job.artifactId = artifact.id; job.status = "COMPLETED";
    } catch (error) {
      if (controller.signal.aborted) job.status = "CANCELLED";
      else { job.status = "FAILED"; job.error = error instanceof Error ? error.message.slice(0, 200) : "Generation failed."; }
    } finally { job.completedAt = new Date().toISOString(); this.controllers.delete(job.id); this.active--; }
  }
  cancel(id: string): StudioJob | undefined {
    const job = this.jobs.get(id), controller = this.controllers.get(id);
    if (!job) return undefined;
    if (controller && ["QUEUED", "RUNNING"].includes(job.status)) { job.status = "CANCEL_REQUESTED"; controller.abort(); }
    return structuredClone(job);
  }
  stopAll() { for (const id of this.controllers.keys()) this.cancel(id); }
}
