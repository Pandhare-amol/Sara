import { createHash } from "node:crypto";
import type { TaskRecord } from "../../../server_state";

export type BrowserStep =
  | { action: "navigate"; url: string }
  | { action: "read"; contains?: string }
  | { action: "click"; role: "button" | "link"; name: string; expect: { type: "url" | "text"; value: string } }
  | { action: "fill"; label: string; value: string };

export interface BrowserWorkflowState {
  version: 1;
  host: string;
  startUrl: string;
  steps: BrowserStep[];
  digest: string;
  approval?: { index: number; expiresAt: number; used: boolean; digest: string };
}
export interface BrowserCheckpoint {
  currentIndex: number;
  inFlightIndex?: number;
  uncertainStepIndex?: number;
  pendingApproval?: number;
  completed: Array<{ index: number; action: BrowserStep["action"]; evidence: string; observedAt: string }>;
  stopRequested?: "pause" | "cancel";
  expectedPostcondition?: string;
}
export interface BrowserToolCall {
  taskId: string;
  operation: "navigate" | "read" | "click" | "fill" | "inspect" | "close";
  url?: string;
  role?: string;
  name?: string;
  label?: string;
  value?: string;
  expect?: { type: "url" | "text" | "field_value"; value: string; label?: string };
}
export interface BrowserToolResult {
  ok: boolean;
  verified?: boolean;
  url?: string;
  text?: string;
  error?: string;
  result?: string;
}
export interface WorkflowStore {
  createTask(input: { conversationId: string; description: string; status: "paused"; assignedAgent: string; metadata: Record<string, unknown> }): Promise<TaskRecord>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null>;
  loadTasks(): Promise<TaskRecord[]>;
}
export interface WorkflowPlanner {
  (goal: string, startUrl: string): Promise<unknown>;
}

const PRIVATE_SUFFIX = /(?:^localhost$|\.(?:localhost|local|internal|test|invalid)$)/i;
const SECRET = /password|passphrase|private.?key|api.?key|access.?token|otp|cvv|credit.?card/i;
// Sending, payments, destructive actions, publishing and login cannot be
// verified from a page text/URL alone. These require purpose-built adapters.
const HIGH_IMPACT_CLICK = /\b(?:send|reply|publish|post|upload|download|buy|purchase|checkout|pay|delete|remove|submit|transfer|withdraw|subscribe|install|login|sign.?in|sign.?out|order|save)\b/i;
const MAX_STEPS = 5;
const MAX_RUNTIME_MS = 90_000;

export function publicHttpsUrl(input: string, host?: string): URL {
  if (typeof input !== "string" || input.length > 1200 || !input.trim()) throw new Error("A short HTTPS URL is required.");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Invalid URL."); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
      !hostname.includes(".") || PRIVATE_SUFFIX.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
      hostname.startsWith("[") || hostname.includes(":") || hostname.length > 253) {
    throw new Error("Only public HTTPS hostnames on port 443 are supported.");
  }
  if (host && hostname !== host) throw new Error("Steps may only visit the user-selected hostname.");
  if (SECRET.test(url.search + url.hash)) throw new Error("Credentials must not appear in workflow URLs.");
  return url;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error("Plan contains unsupported or missing fields.");
  }
}
function shortText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

/** Reject, rather than repair, malformed/unbounded model output. No extra tool fields. */
export function validateBrowserPlan(modelOutput: unknown, startUrl: string): BrowserStep[] {
  const start = publicHttpsUrl(startUrl);
  const plan = typeof modelOutput === "string" ? JSON.parse(modelOutput) as unknown : modelOutput;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("A JSON plan object is required.");
  exactKeys(plan as Record<string, unknown>, ["steps"]);
  const input = (plan as { steps: unknown }).steps;
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_STEPS) throw new Error("Plan must have 1–5 steps.");
  let writes = 0;
  const steps = input.map((raw, index): BrowserStep => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid browser step.");
    const item = raw as Record<string, unknown>;
    switch (item.action) {
      case "navigate": {
        exactKeys(item, ["action", "url"]);
        const url = publicHttpsUrl(item.url as string, start.hostname).href;
        if (index === 0 && url !== start.href) throw new Error("First step must visit the user-selected starting URL.");
        return { action: "navigate", url };
      }
      case "read": {
        exactKeys(item, ["action"], ["contains"]);
        return { action: "read", ...(item.contains === undefined ? {} : { contains: shortText(item.contains, "text to find", 120) }) };
      }
      case "click": {
        exactKeys(item, ["action", "role", "name", "expect"]);
        if (++writes > 2) throw new Error("Plan has too many consequential actions.");
        if (item.role !== "button" && item.role !== "link") throw new Error("Only semantic buttons and links are supported.");
        const name = shortText(item.name, "accessible name", 100);
        if (SECRET.test(name) || HIGH_IMPACT_CLICK.test(name)) throw new Error("Sensitive or high-impact controls cannot be clicked in a workflow.");
        const expect = item.expect;
        if (!expect || typeof expect !== "object" || Array.isArray(expect)) throw new Error("Click requires a postcondition.");
        exactKeys(expect as Record<string, unknown>, ["type", "value"]);
        const check = expect as Record<string, unknown>;
        if (check.type !== "url" && check.type !== "text") throw new Error("Unsupported postcondition.");
        const value = check.type === "url" ? publicHttpsUrl(check.value as string, start.hostname).href : shortText(check.value, "visible text", 120);
        return { action: "click", role: item.role, name, expect: { type: check.type, value } };
      }
      case "fill": {
        exactKeys(item, ["action", "label", "value"]);
        if (++writes > 2) throw new Error("Plan has too many consequential actions.");
        const label = shortText(item.label, "field label", 100);
        const value = shortText(item.value, "field value", 200);
        if (SECRET.test(label) || SECRET.test(value)) throw new Error("Credential and payment fields are not supported.");
        return { action: "fill", label, value };
      }
      default: throw new Error("Plan proposed an unsupported tool or action.");
    }
  });
  if (steps[0].action !== "navigate") throw new Error("Plan must start with navigation.");
  return steps;
}

export function expectedBrowserEffect(step: BrowserStep): string {
  switch (step.action) {
    case "navigate": return `URL equals ${step.url}`;
    case "read": return step.contains ? `Visible page contains ${step.contains}` : "Read visible page text";
    case "click": return step.expect.type === "url" ? `URL equals ${step.expect.value}` : `Visible text contains ${step.expect.value}`;
    case "fill": return `Labeled field ${step.label} equals the reviewed value`;
  }
}

export function browserPostconditionObserved(observation: BrowserToolResult, expectedHost: string): boolean {
  try {
    return observation.ok === true && observation.verified === true && typeof observation.url === "string" &&
      publicHttpsUrl(observation.url, expectedHost) !== undefined;
  } catch { return false; }
}

function workflow(task: TaskRecord): BrowserWorkflowState {
  const state = task.metadata?.workflow as BrowserWorkflowState | undefined;
  if (!state || state.version !== 1 || !Array.isArray(state.steps) ||
      state.digest !== createHash("sha256").update(JSON.stringify({ host: state.host, startUrl: state.startUrl, steps: state.steps })).digest("hex")) {
    throw new Error("Stored workflow is missing or its plan has changed. Start a new task.");
  }
  // A stored plan, including one edited through an older API, must still pass policy.
  validateBrowserPlan({ steps: state.steps }, state.startUrl);
  return state;
}
function checkpoint(task: TaskRecord): BrowserCheckpoint {
  const stored = task.checkpoint as unknown as BrowserCheckpoint | null;
  if (!stored || !Number.isInteger(stored.currentIndex) || !Array.isArray(stored.completed)) {
    return { currentIndex: 0, completed: [] };
  }
  return stored;
}

/** One-task-at-a-time per ID; approvals and checkpoints persist in the existing task store. */
export class BrowserWorkflowEngine {
  private readonly active = new Map<string, Promise<void>>();
  private readonly approvalsInProgress = new Set<string>();
  private readonly stops = new Map<string, "pause" | "cancel">();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly stopTickets = new Map<string, number>();
  private readonly finalizing = new Set<string>();
  constructor(private readonly store: WorkflowStore, private readonly planner: WorkflowPlanner,
              private readonly tool: (call: BrowserToolCall, authorized: boolean, host: string) => Promise<BrowserToolResult>) {}

  /** Serialize UI transitions, not the long-running desktop call itself. */
  private async transition<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(id);
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.transitions.set(id, next);
    if (previous) await previous;
    try { return await action(); }
    finally {
      release();
      if (this.transitions.get(id) === next) this.transitions.delete(id);
    }
  }

  async prepare(goal: string, startUrl: string, conversationId = "browser-workflow"): Promise<TaskRecord> {
    const safeGoal = shortText(goal, "goal", 500);
    const start = publicHttpsUrl(startUrl);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(conversationId)) throw new Error("Invalid conversation ID.");
    const output = await this.planner(safeGoal, start.href);
    const steps = validateBrowserPlan(output, start.href);
    const state: BrowserWorkflowState = {
      version: 1, host: start.hostname, startUrl: start.href, steps,
      digest: createHash("sha256").update(JSON.stringify({ host: start.hostname, startUrl: start.href, steps })).digest("hex"),
    };
    const task = await this.store.createTask({ conversationId, description: safeGoal, status: "paused", assignedAgent: "BrowserWorkflow",
      metadata: { workflow: state } });
    // A paused task is a plan proposal, not an automatically executable task.
    return (await this.store.updateTask(task.taskId, { checkpoint: { currentIndex: 0, completed: [] } }))!;
  }

  async get(id: string): Promise<TaskRecord> {
    const task = (await this.store.loadTasks()).find((item) => item.taskId === id);
    if (!task || !task.metadata?.workflow) throw new Error("Browser workflow not found.");
    workflow(task);
    // Stop intent is process-local until the in-flight browser call settles.
    // Expose it to the UI without a competing stale checkpoint write.
    const stopRequested = this.stops.get(id);
    if (stopRequested && this.active.has(id) && !["completed", "failed", "partial", "cancelled"].includes(task.status)) {
      return { ...task, checkpoint: { ...checkpoint(task), stopRequested } };
    }
    return task;
  }

  async recover(): Promise<void> {
    for (const task of await this.store.loadTasks()) {
      if (!task.metadata?.workflow || task.status !== "running") continue;
      const cp = checkpoint(task);
      await this.store.updateTask(task.taskId, { status: "paused", error: "Interrupted browser action may have changed the page. Do not replay; inspect manually and create a new plan.",
        checkpoint: { ...cp, uncertainStepIndex: cp.inFlightIndex ?? cp.currentIndex } });
    }
  }

  async start(id: string): Promise<TaskRecord> {
    return this.transition(id, () => this.startUnlocked(id));
  }

  private async startUnlocked(id: string): Promise<TaskRecord> {
    if (this.stops.has(id)) throw new Error("Workflow is stopping; do not start another action.");
    const task = await this.get(id);
    // The read above is asynchronous. A cancellation may have arrived while it
    // was in progress, even if this snapshot still says "paused".
    if (this.stops.has(id)) throw new Error("Workflow is stopping; do not start another action.");
    const cp = checkpoint(task);
    if (cp.uncertainStepIndex !== undefined) throw new Error("A previous action is uncertain; do not replay it.");
    if (task.status !== "paused" && task.status !== "awaiting_confirmation") throw new Error("Workflow is not paused for review.");
    if (task.status === "awaiting_confirmation" && workflow(task).approval?.index !== cp.currentIndex) {
      throw new Error("Authenticate and approve this exact step before continuing.");
    }
    if (!this.active.has(id)) {
      if (this.stops.has(id)) throw new Error("Workflow is stopping; do not start another action.");
      const run = this.drive(id)
        .catch(() => { console.error("[BrowserWorkflow] Workflow stopped after a persistence failure; review its task before retrying."); })
        .finally(() => {
          this.active.delete(id);
          // A stop may be queued behind an approval/start transition. Do not
          // erase that intent until its own transition has persisted a result.
          if (!this.transitions.has(id)) {
            this.stops.delete(id);
            this.stopTickets.delete(id);
          }
        });
      this.active.set(id, run);
    }
    return this.get(id);
  }

  async approve(id: string, index: number, digest: string): Promise<TaskRecord> {
    if (this.approvalsInProgress.has(id)) throw new Error("An approval is already being processed.");
    this.approvalsInProgress.add(id);
    try {
      return await this.transition(id, async () => {
        if (this.stops.has(id)) throw new Error("Workflow is stopping; approval was not used.");
        const task = await this.get(id);
        const state = workflow(task);
        const cp = checkpoint(task);
        if (task.status !== "awaiting_confirmation" || cp.currentIndex !== index || cp.pendingApproval !== index ||
            !Number.isInteger(index) || state.digest !== digest || !["click", "fill"].includes(state.steps[index]?.action)) {
          throw new Error("Approval does not match the pending, unchanged plan step.");
        }
        // A previous run may have persisted awaiting_confirmation but not yet
        // completed its final Promise microtask. Wait for that clean exit only.
        const pendingRun = this.active.get(id);
        if (pendingRun) await pendingRun;
        if (this.stops.has(id) || this.active.has(id) || (await this.get(id)).status !== "awaiting_confirmation" || this.stops.has(id)) {
          throw new Error("Workflow is no longer waiting for approval.");
        }
        await this.store.updateTask(id, { metadata: { ...task.metadata, workflow: { ...state, approval: {
          index, digest, expiresAt: Date.now() + 60_000, used: false,
        } } } });
        return this.startUnlocked(id);
      });
    } finally { this.approvalsInProgress.delete(id); }
  }

  async stop(id: string, reason: "pause" | "cancel"): Promise<TaskRecord> {
    // After all postconditions were independently verified there are no more
    // task actions to stop. Wait for the terminal commit instead of accepting
    // a cancellation that cannot be applied to a completed task.
    if (this.finalizing.has(id)) {
      const run = this.active.get(id);
      if (run) await run;
      throw new Error("Workflow already verified its final step; review the completed outcome.");
    }
    // Set the intent before any asynchronous read. Cancellation wins over a
    // simultaneous pause and prevents a queued stale start/approval dispatch.
    const ticket = (this.stopTickets.get(id) ?? 0) + 1;
    this.stopTickets.set(id, ticket);
    if (reason === "cancel" || this.stops.get(id) !== "cancel") this.stops.set(id, reason);
    return this.transition(id, async () => {
      try {
        const task = await this.get(id);
        const effectiveReason = this.stops.get(id) || reason;
        if (task.status === "cancelled" && effectiveReason === "cancel") return task;
        if (task.status === "paused" && effectiveReason === "pause" && !this.active.has(id)) return task;
        if (["completed", "failed", "partial", "cancelled"].includes(task.status)) throw new Error("Workflow has already ended.");
        if (this.active.has(id) && task.status !== "awaiting_confirmation") {
          // The drive owns persistence of the final checkpoint. Concurrent
          // checkpoint writes here could resurrect an in-flight action marker.
          return { ...task, checkpoint: { ...checkpoint(task), stopRequested: effectiveReason } };
        }
        const updated = await this.store.updateTask(id, { status: effectiveReason === "cancel" ? "cancelled" : "paused",
          metadata: { ...task.metadata, workflow: { ...workflow(task), approval: undefined } },
          completedAt: effectiveReason === "cancel" ? new Date().toISOString() : undefined,
          checkpoint: { ...checkpoint(task), pendingApproval: undefined, stopRequested: undefined } });
        if (effectiveReason === "cancel") void this.tool({ taskId: id, operation: "close" }, false, workflow(task).host).catch(() => {});
        return updated!;
      } finally {
        // Do not clear a newer stop that is queued behind this one.
        if (!this.active.has(id) && this.stopTickets.get(id) === ticket) {
          this.stops.delete(id);
          this.stopTickets.delete(id);
        }
      }
    });
  }

  private async drive(id: string): Promise<void> {
    const begunAt = Date.now();
    try {
      for (;;) {
        const task = await this.get(id);
        const state = workflow(task);
        const cp = checkpoint(task);
        // An out-of-date start must never revive a task already cancelled or
        // completed by another transition.
        if (["cancelled", "completed", "partial", "failed"].includes(task.status)) return;
        if (this.stops.has(id)) { await this.finishStop(task); return; }
        if (Date.now() - begunAt > MAX_RUNTIME_MS) throw new Error("Workflow time budget exceeded; last action may be uncertain.");
        if (cp.currentIndex >= state.steps.length) {
          this.finalizing.add(id);
          try {
            // Keep the task non-terminal until best-effort browser cleanup has
            // finished. Observers must not see "completed" while the tab is
            // still being closed (or race a follow-up workflow against it).
            await this.tool({ taskId: id, operation: "close" }, false, state.host).catch(() => {});
            await this.store.updateTask(id, { status: "completed", completedAt: new Date().toISOString(),
              result: `Verified ${cp.completed.length} browser steps. No unverified external outcome is claimed.` });
          } finally { this.finalizing.delete(id); }
          return;
        }
        const index = cp.currentIndex;
        const step = state.steps[index];
        const consequential = step.action === "click" || step.action === "fill";
        const approval = state.approval;
        if (consequential && (!approval || approval.index !== index || approval.digest !== state.digest || approval.used || approval.expiresAt <= Date.now())) {
          await this.store.updateTask(id, { status: "awaiting_confirmation", checkpoint: { ...cp, pendingApproval: index, inFlightIndex: undefined },
            metadata: { ...task.metadata, workflow: { ...state, approval: undefined } } });
          if (this.stops.has(id)) await this.finishStop(await this.get(id));
          return;
        }
        // Persist the consumed approval AND an in-flight marker before the call.
        // After a crash there is no way to know whether a side effect happened.
        await this.store.updateTask(id, { status: "running", startedAt: task.startedAt || new Date().toISOString(),
          metadata: { ...task.metadata, workflow: { ...state, approval: approval ? { ...approval, used: true } : undefined } },
          checkpoint: { ...cp, pendingApproval: undefined, inFlightIndex: index, expectedPostcondition: expectedBrowserEffect(step) } });
        // A stop can arrive while the in-flight marker is being persisted.
        // In this case the action never started, so clear that marker and do
        // not call the desktop agent at all.
        if (this.stops.has(id)) { await this.finishStop(await this.get(id), true); return; }
        const operation: BrowserToolCall = { taskId: id, operation: step.action,
          ...(step.action === "navigate" ? { url: step.url } : {}),
          ...(step.action === "click" ? { role: step.role, name: step.name } : {}),
          ...(step.action === "fill" ? { label: step.label, value: step.value } : {}) };
        const result = await this.tool(operation, consequential, state.host);
        if (!result.ok) throw new Error(result.error || "Browser tool failed; outcome may be uncertain.");
        let verified = false;
        let evidence = "";
        if (step.action === "read") {
          verified = browserPostconditionObserved(result, state.host) && typeof result.text === "string" &&
            (!step.contains || result.text.toLowerCase().includes(step.contains.toLowerCase()));
          evidence = verified ? `Read actual page at ${result.url}: ${result.text!.slice(0, 250)}` : "Page text was unavailable or expected text was absent.";
        } else {
          const expect = step.action === "navigate" ? { type: "url" as const, value: step.url }
            : step.action === "click" ? step.expect
              : { type: "field_value" as const, label: step.label, value: step.value };
          const observation = await this.tool({ taskId: id, operation: "inspect", expect }, false, state.host);
          verified = browserPostconditionObserved(observation, state.host);
          evidence = verified ? `${step.action} postcondition observed on ${observation.url}` : "Independent postcondition was not observed.";
        }
        if (!verified) throw new Error(evidence);
        await this.store.updateTask(id, { status: "running", error: undefined,
          checkpoint: { currentIndex: index + 1, completed: [...cp.completed, { index, action: step.action, evidence, observedAt: new Date().toISOString() }],
            last_action: step.action, last_verified_result: evidence, task_progress: Math.round((index + 1) * 100 / state.steps.length) },
          metadata: { ...task.metadata, workflow: { ...state, approval: undefined } } });
        if (this.stops.has(id)) { await this.finishStop(await this.get(id)); return; }
      }
    } catch (error) {
      const task = await this.get(id).catch(() => null);
      if (!task) return;
      const cp = checkpoint(task);
      await this.store.updateTask(id, { status: "partial", error: error instanceof Error ? error.message.slice(0, 250) : "Browser outcome uncertain.",
        completedAt: new Date().toISOString(), checkpoint: { ...cp, uncertainStepIndex: cp.inFlightIndex ?? cp.currentIndex } });
      await this.tool({ taskId: id, operation: "close" }, false, workflow(task).host).catch(() => {});
    }
  }

  private async finishStop(task: TaskRecord, beforeDispatch = false): Promise<void> {
    const reason = this.stops.get(task.taskId)!;
    const cp = checkpoint(task);
    await this.store.updateTask(task.taskId, { status: reason === "cancel" ? "cancelled" : "paused",
      completedAt: reason === "cancel" ? new Date().toISOString() : undefined,
      checkpoint: { ...cp, stopRequested: undefined,
        ...(beforeDispatch ? { inFlightIndex: undefined, expectedPostcondition: undefined } : {}) },
      metadata: { ...task.metadata, workflow: { ...workflow(task), approval: undefined } } });
    if (reason === "cancel") await this.tool({ taskId: task.taskId, operation: "close" }, false, workflow(task).host).catch(() => {});
  }
}
