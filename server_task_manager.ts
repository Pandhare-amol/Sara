import EventEmitter from 'events';
import { loadTasks, updateTask, loadToolCalls } from './server_state';
import fs from 'fs/promises';
import { dataFile } from './server_paths';
import { callDesktopAgent as defaultCallDesktopAgent, logToolCall } from './desktop_agent_bridge';
import { sysLogger } from './server_logger';
import { GoogleGenAI, Type } from '@google/genai';
import { createUserResponseFromResult } from './src/types/AuthoritativeTaskResult';
import { buildInterruptedTaskPatch } from './src/core/taskRecovery';
import { FilesystemVerifier } from './src/core/tools/verification/filesystemVerifier';
import type { AuthoritativeTaskResult, ExecutionState, VerificationResult, ExecutionError } from './src/types/AuthoritativeTaskResult';

const AUTONOMY_LEVEL = parseInt(process.env.AUTONOMY_LEVEL || '3');

type TaskStatus = 'queued' | 'planning' | 'running' | 'waiting' | 'paused' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'RECOVERING' | 'awaiting_confirmation' | 'partial' | 'timed_out' | 'blocked' | 'succeeded';

const DANGEROUS_TOOLS = [
  'os.shutdown', 'os.restart', 'files.delete', 'deleteFile', 'deleteFilePermanent',
  'closeAllApplications', 'requestPowerAction', 'executePowerAction',
  'whatsapp_send', 'whatsappSend', 'whatsapp_reply', 'whatsappReply',
  'whatsapp_group_send', 'whatsapp_send_media', 'email_send', 'emailSend',
  'youtube_upload', 'youtubeUpload', 'communication.bulk_send',
];

const FILESYSTEM_VERIFIER = new FilesystemVerifier();
const FILESYSTEM_TOOLS = new Set(["copyFile", "moveFile", "deleteFile", "createFile", "createFolder", "renameFile", "writeFile", "duplicateFile"]);

/**
 * Verify file postconditions independently; a successful tool response alone is not proof.
 */
async function verifyFileOperation(
  tool: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; error?: string; result?: unknown; canonical?: unknown }
): Promise<VerificationResult> {
  const verification = await FILESYSTEM_VERIFIER.verify(tool, args, outcome);
  const checks = [
    { name: 'tool_returned_ok', passed: outcome.ok, reason: outcome.ok ? undefined : outcome.error },
    ...verification.checks,
  ];
  const passed = Boolean(outcome.ok && verification.verified);
  return {
    attempted: true,
    passed,
    method: 'independent_file_system_postcondition',
    checks,
    details: passed ? verification.details : outcome.error || verification.details,
  };
}

/**
 * Build a verification result for browser operations.
 */
async function verifyBrowserOperation(
  tool: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; error?: string; result?: unknown; canonical?: unknown }
): Promise<VerificationResult> {
  const canonical = (outcome.canonical && typeof outcome.canonical === 'object'
    ? outcome.canonical
    : outcome.result && typeof outcome.result === 'object' ? outcome.result : {}) as Record<string, any>;
  const explicitlyVerified = canonical.verified === true ||
    String(canonical.verification_status || canonical.verificationStatus || '').toUpperCase() === 'VERIFIED';
  const checks = [
    { name: 'browser_tool_returned_ok', passed: outcome.ok, evidence: { tool, outcome: outcome.ok } },
    { name: 'browser_postcondition_independently_verified', passed: explicitlyVerified, reason: explicitlyVerified ? undefined : 'The browser tool returned without independent postcondition evidence.' },
  ];
  const passed = Boolean(outcome.ok && explicitlyVerified);
  return {
    attempted: true,
    passed,
    method: explicitlyVerified ? 'independent_browser_verification' : 'browser_outcome_only',
    checks,
    details: passed ? 'Browser operation verified.' : outcome.error || 'Browser operation ran, but its postcondition could not be independently verified. Review the browser before retrying.',
  };
}

/**
 * Build the canonical authoritative task result.
 * Success is only true if outcome.ok AND verification.passed.
 */
export function buildStructuredExecutionResult(
  taskId: string,
  requestedAction: string,
  startedAt: string,
  executedTool: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; result?: unknown; error?: string },
  verification: VerificationResult
): AuthoritativeTaskResult {
  const outcomeSucceeded = Boolean(outcome.ok);
  const verificationPassed = verification?.attempted === true && verification?.passed === true;
  const success = outcomeSucceeded && verificationPassed;

  const state: ExecutionState = success ? 'SUCCEEDED' : 'FAILED';
  const verificationFailureMessage = !verificationPassed && verification?.details ? String(verification.details) : undefined;
  const error: ExecutionError | undefined = outcome.error
    ? { code: 'TOOL_FAILURE', message: String(outcome.error), recoverable: true }
    : verificationFailureMessage
      ? { code: 'VERIFICATION_FAILED', message: verificationFailureMessage, recoverable: true }
      : undefined;

  const result: AuthoritativeTaskResult = {
    taskId,
    goal: requestedAction,
    summary: success
      ? `Successfully completed: ${requestedAction}`
      : `Failed to complete: ${requestedAction}${error?.message ? ` — ${error.message}` : ''}`,
    state,
    success,
    verified: verification?.attempted === true && verification?.passed === true,
    actions: [
      {
        tool: executedTool,
        arguments: args,
        startedAt,
        completedAt: new Date().toISOString(),
        success,
        result: success ? outcome.result : undefined,
        error: outcome.error ? { code: 'TOOL_FAILURE', message: String(outcome.error) } : error ? { code: error.code || 'VERIFICATION_FAILED', message: error.message } : undefined,
      },
    ],
    verification,
    error,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
  };

  result.userMessage = createUserResponseFromResult(result);
  return result;
}

function hasAutoCloseRequest(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((child) => hasAutoCloseRequest(child, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.auto_close_after_task === true && record.ok === true && record.verified === true) return true;
  return ["data", "result", "executionResult", "canonical", "unified", "execution"].some((key) =>
    hasAutoCloseRequest(record[key], depth + 1),
  );
}

function summarizeAutoCloseOutcome(outcome: any): NonNullable<AuthoritativeTaskResult["autoClose"]> {
  const result = outcome?.result && typeof outcome.result === "object" ? outcome.result as Record<string, any> : {};
  const payload = result.data && typeof result.data === "object" ? result.data as Record<string, any> : result;
  return {
    ok: payload.ok === true,
    verified: payload.verified === true,
    status: String(payload.status || (payload.ok === true ? "completed" : "left_open")),
    closed: Array.isArray(payload.closed) ? payload.closed : [],
    left_open: Array.isArray(payload.left_open) ? payload.left_open : [],
    result: String(payload.result || outcome?.error || "Graceful close outcome could not be verified; the app was left open."),
  };
}

export type { AuthoritativeTaskResult, VerificationResult };

export function inferTaskToolCall(task: any): { tool: string; args: Record<string, unknown> } {
  const description = String(task?.description || "").trim();
  if (!description) {
    return { tool: "saraAgentExecute", args: { goal: "General task" } };
  }

  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const youtubeUrlMatch = /https?:\/\/(?:www\.)?(?:youtube\.com|m\.youtube\.com|youtu\.be)\/[^\s]+/i.exec(description);
  if (youtubeUrlMatch && /\b(?:play|watch)\b/i.test(description)) {
    return { tool: "youtube_play", args: { url: youtubeUrlMatch[0].replace(/[),.!?]+$/, "") } };
  }
  const youtubePlay = /\b(?:play|watch)\s+(.+?)(?:\s+on\s+youtube)?[.!?]*$/i.exec(description);
  if (/\byoutube\b/i.test(description) && youtubePlay) {
    const query = youtubePlay[1].replace(/\s+on\s+youtube[.!?]*$/i, "").trim();
    return { tool: "youtube_play", args: { query } };
  }
  const cleanSearchQuery = (raw: string, engine?: string): string => {
    let query = raw.trim();
    if (engine) {
      const escapedEngine = escapeRegex(engine);
      query = query.replace(new RegExp(`^(?:(?:on|in|using)\\s+)?${escapedEngine}(?:\\s+for)?\\s+`, "i"), "");
      query = query.replace(new RegExp(`\\s+(?:on|in|using)\\s+${escapedEngine}\\b`, "i"), "");
    }
    return query.replace(/^(?:for|on|in|using)\s+/i, "").trim();
  };
  const searchMatch = /\b(?:search|find|look up)\s+(.+?)[.!?]*$/i.exec(description);
  if (/\bgoogle\b/i.test(description) && searchMatch) {
    const query = cleanSearchQuery(searchMatch[1], "google");
    return { tool: "searchGoogle", args: { query: query || "search" } };
  }
  if (/\bgithub\b/i.test(description) && searchMatch) {
    const query = cleanSearchQuery(searchMatch[1], "github");
    return { tool: "searchGitHub", args: { query: query || "project" } };
  }
  if (/\byoutube\b/i.test(description) && searchMatch) {
    const query = cleanSearchQuery(searchMatch[1], "youtube");
    return { tool: "searchYouTube", args: { query: query || "video" } };
  }
  if (searchMatch) {
    const query = cleanSearchQuery(searchMatch[1]);
    return { tool: "searchWeb", args: { query: query || "query" } };
  }

  if (/\b(?:close|shut)\s+(?:the\s+)?(?:current\s+)?tab\b/i.test(description)) {
    return { tool: "desktopBrowserCloseTab", args: {} };
  }
  if (/\b(?:open|create)\s+(?:a\s+)?new\s+tab\b/i.test(description)) {
    return { tool: "desktopBrowserOpenTab", args: {} };
  }

  const appAliases = ([
    ["google chrome", "chrome"], ["chrome", "chrome"], ["microsoft edge", "edge"], ["edge", "edge"],
    ["firefox browser", "firefox"], ["firefox", "firefox"], ["brave browser", "brave"], ["brave", "brave"],
    ["visual studio code", "vscode"], ["vs code", "vscode"], ["vscode", "vscode"], ["code editor", "vscode"],
    ["file explorer", "file explorer"], ["windows explorer", "file explorer"], ["explorer", "file explorer"],
    ["task manager", "task manager"], ["calculator", "calculator"], ["calc", "calculator"], ["settings", "settings"],
    ["command prompt", "command prompt"], ["powershell", "powershell"], ["notepad", "notepad"], ["wordpad", "wordpad"],
    ["snipping tool", "snipping tool"], ["whatsapp desktop", "whatsapp"], ["whatsapp", "whatsapp"],
    ["visual studio", "visual studio"], ["github desktop", "github desktop"], ["docker desktop", "docker desktop"],
    ["libreoffice", "libreoffice"], ["thunderbird", "thunderbird"], ["powerpoint", "powerpoint"],
    ["onenote", "onenote"], ["spotify", "spotify"], ["discord", "discord"], ["slack", "slack"], ["teams", "teams"],
    ["zoom", "zoom"], ["pycharm", "pycharm"], ["obsidian", "obsidian"], ["vlc", "vlc"],
    ["excel", "excel"], ["word", "word"], ["paint", "paint"], ["camera", "camera"],
  ] as Array<[string, string]>).sort((left, right) => right[0].length - left[0].length);
  const appAction = /\b(open|launch|start|close|quit|exit)\s+(?:the\s+)?(?:(?:app|application|program)\s+)?(.+)/i.exec(description);
  if (appAction) {
    const action = appAction[1].toLowerCase();
    const remainder = appAction[2].replace(/[.!?]+$/, "").trim();
    const alias = appAliases.find(([name]) => new RegExp(`^${escapeRegex(name)}(?:\\s+(?:app|application|program|window))?(?:$|\\s)`, "i").test(remainder));
    if (alias) {
      return { tool: ["close", "quit", "exit"].includes(action) ? "closeApplication" : "openApplication", args: { name: alias[1] } };
    }
    const genericApp = /^(?:the\s+)?(?:app|application|program)\s+(.+)$/i.exec(remainder);
    if (genericApp && ["open", "launch", "start"].includes(action)) {
      return { tool: "openApplication", args: { name: genericApp[1].trim() } };
    }
  }

  const namedSites: Array<[string, string]> = [
    ["youtube", "youtube"], ["google", "google"], ["github", "github"], ["gmail", "gmail"],
    ["chatgpt", "chatgpt"], ["instagram", "instagram"], ["docs", "docs"], ["wikipedia", "wikipedia"],
    ["amazon", "amazon"], ["netflix", "netflix"], ["spotify", "spotify"],
  ];
  const openTargetMatch = /\b(?:open|go to|visit|launch)\s+(?:the\s+)?([a-z0-9.-]+(?:\.[a-z0-9.-]+)+|youtube|google|github|gmail|chatgpt|instagram|docs|wikipedia|amazon|netflix|spotify)(?:\s|$)/i.exec(description);
  const namedSite = namedSites.find(([site]) => new RegExp(`\\b${escapeRegex(site)}\\b`, "i").test(description));
  if (/\b(?:open|go to|visit|launch)\b/i.test(description) || namedSite) {
    const target = openTargetMatch ? openTargetMatch[1].trim() : (namedSite?.[1] || "website");
    return { tool: "openWebsite", args: { name: target } };
  }

  if (/\b(?:click|type|open tab|close tab|navigate|scroll|refresh|back|forward)\b/i.test(description) || /\b(?:browser|website)\b/i.test(description)) {
    return { tool: "desktopBrowserOpen", args: { url: "https://www.google.com" } };
  }

  return { tool: "saraAgentExecute", args: { goal: description } };
}
export class TaskRunner extends EventEmitter {
  private concurrency = 2;
  private running = 0;
  private activeTaskIds = new Set<string>();
  private stopRequestedTaskIds = new Set<string>();
  private queueWake = false;
  private stopped = false;
  private callDesktopAgent: (tool: string, args: Record<string, unknown>, originalArgs?: Record<string, unknown>) => Promise<any>;

  constructor(callAgent?: typeof defaultCallDesktopAgent, autoStart = true) {
    super();
    this.callDesktopAgent = callAgent || defaultCallDesktopAgent;
    if (autoStart) {
      void this.recoverInterruptedTasks()
        .catch((error) => console.error('[TaskRunner] interrupted-task recovery failed', error))
        .finally(() => { void this.loop(); });
    }
  }

  private async recoverInterruptedTasks() {
    const tasks = await loadTasks();
    for (const task of tasks) {
      const patch = buildInterruptedTaskPatch(task);
      if (!patch) continue;
      const updated = await updateTask(task.taskId, patch as any);
      if (updated) {
        console.warn(`[TaskRunner] paused interrupted task ${task.taskId} from ${task.status}; checkpoint preserved, automatic replay disabled`);
      }
    }
  }

  public async wake() {
    this.queueWake = true;
  }

  // Report progress for a running task: updates checkpoint and emits progress
  public async reportProgress(taskId: string, progress: Record<string, unknown>) {
    try {
      const current = (await loadTasks()).find((task) => task.taskId === taskId);
      const checkpoint = { ...(current?.checkpoint || {}), ...progress };
      const updated = await updateTask(taskId, { checkpoint, updatedAt: new Date().toISOString() } as any);
      this.emit('taskProgress', { taskId, progress, task: updated });
      return updated;
    } catch (e) {
      console.error('[TaskRunner] reportProgress error', e);
      return null;
    }
  }

  public stop() {
    this.stopped = true;
  }

  /** Cancel only not-yet-started work and cooperatively stop active task flows. */
  public async emergencyStop(): Promise<{ cancelledQueuedTaskIds: string[]; cancellationRequestedTaskIds: string[] }> {
    const cancelledQueuedTaskIds: string[] = [];
    const cancellationRequestedTaskIds: string[] = [];
    const tasks = await loadTasks();
    for (const task of tasks) {
      if (task.metadata?.automation) continue;
      if (this.activeTaskIds.has(task.taskId) || task.status === "running") {
        this.stopRequestedTaskIds.add(task.taskId);
        const requestedAt = new Date().toISOString();
        const updated = await updateTask(task.taskId, {
          checkpoint: {
            ...(task.checkpoint || {}),
            cancellation: { requested: true, requestedAt, actionMayHaveCompleted: true, automaticReplay: false },
          },
          metadata: { ...(task.metadata || {}), cancellationRequestedAt: requestedAt },
          updatedAt: requestedAt,
        } as any);
        if (updated) {
          cancellationRequestedTaskIds.push(task.taskId);
          this.emit("taskUpdated", updated);
        }
      } else if (task.status === "queued") {
        const updated = await updateTask(task.taskId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Cancelled by emergency stop before execution; no tool call was started.",
        } as any);
        if (updated) {
          cancelledQueuedTaskIds.push(task.taskId);
          this.emit("taskUpdated", updated);
        }
      }
    }
    return { cancelledQueuedTaskIds, cancellationRequestedTaskIds };
  }

  private async cancelBeforeExecution(task: any): Promise<void> {
    const cancelledAt = new Date().toISOString();
    const updated = await updateTask(task.taskId, {
      status: "cancelled",
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
      error: "Cancelled by emergency stop before any tool call was started.",
      checkpoint: {
        ...(task.checkpoint || {}),
        cancellation: { requested: true, actionStarted: false, automaticReplay: false },
      },
    } as any);
    if (updated) this.emit("taskUpdated", updated);
    this.stopRequestedTaskIds.delete(task.taskId);
  }

  private async pauseForEmergencyStop(task: any, outcome?: unknown): Promise<void> {
    const requestedAt = new Date().toISOString();
    const current = (await loadTasks()).find((item) => item.taskId === task.taskId) || task;
    const error = "Stop requested while this task may have been running. The current tool call may have completed external effects; review the actual state before retrying. SARA will not replay the task automatically.";
    const checkpoint = {
      ...(current.checkpoint || {}),
      cancellation: { requested: true, actionMayHaveCompleted: true, automaticReplay: false },
      recovery: { state: "paused_for_review", checkpointPreserved: true, automaticReplay: false },
    };
    const patch: Record<string, unknown> = {
      status: "paused",
      updatedAt: requestedAt,
      error,
      checkpoint,
      metadata: { ...(current.metadata || {}), cancellationRequestedAt: current.metadata?.cancellationRequestedAt || requestedAt },
    };
    if (outcome !== undefined) {
      patch.result = JSON.stringify({ cancellation: "requested", outcomeReturned: true, externalEffectsMayHaveOccurred: true });
    }
    const updated = await updateTask(task.taskId, patch as any);
    if (updated) this.emit("taskUpdated", updated);
    this.stopRequestedTaskIds.delete(task.taskId);
  }

  private async pickNextTasks(): Promise<any[]> {
    try {
      const tasks = await loadTasks();
      // Only freshly queued tasks auto-run. In-flight and retry states require
      // explicit review/retry so an interrupted side effect cannot be replayed.
      const candidates = tasks.filter((t) =>
        !t.metadata?.automation && t.status === "queued" && !this.activeTaskIds.has(t.taskId)
      );
      // simple priority sort: lower numeric value = higher priority
      candidates.sort((a: any, b: any) => (a.priority || 5) - (b.priority || 5));
      return candidates.slice(0, Math.max(0, this.concurrency - this.running));
    } catch (e) {
      return [];
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        if (this.running >= this.concurrency) {
          await this.sleep(500);
          continue;
        }
        const next = await this.pickNextTasks();
        if (!next.length) {
          // relaxed sleep; wake may be requested
          this.queueWake = false;
          await this.sleep(1500);
          continue;
        }

        for (const task of next) {
          this.runTask(task).catch((e) => console.error('[TaskRunner] runTask error', e));
        }
      } catch (err: any) {
        console.error('[TaskRunner] loop error', err);
        await this.sleep(1000);
      }
    }
  }

  private async runTask(task: any) {
    if (this.activeTaskIds.has(task.taskId)) return;
    this.activeTaskIds.add(task.taskId);
    this.running += 1;
    let toolDispatchStarted = false;
    try {
      const latest = (await loadTasks()).find((entry) => entry.taskId === task.taskId);
      if (!latest || latest.status !== "queued") return;
      task = latest;
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.cancelBeforeExecution(task);
        return;
      }
      const started = await updateTask(task.taskId, { status: 'running', startedAt: new Date().toISOString() });
      if (!started) return;
      this.emit('taskUpdated', started);
      this.emit('taskStarted', started);

      // Reload the task record from storage in case metadata/tool args were
      // updated after the in-memory task snapshot was taken.
      try {
        const all = await loadTasks();
        const fresh = all.find((t: any) => t.taskId === task.taskId);
        if (fresh) task = fresh;
      } catch {}

      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.cancelBeforeExecution(task);
        return;
      }

      if (task.metadata?.musicWorkflowTaskId) {
        const { executeMusicWorkflowTask } = await import("./src/services/music_studio/autonomous_creator");
        const workflow = await executeMusicWorkflowTask(String(task.metadata.musicWorkflowTaskId));
        if (this.stopRequestedTaskIds.has(task.taskId)) {
          await this.pauseForEmergencyStop(task, { workflow });
          return;
        }
        const succeeded = workflow.status === "COMPLETED";
        const updated = await updateTask(task.taskId, {
          status: succeeded ? "completed" : workflow.status === "WAITING_USER" ? "waiting" : "failed",
          completedAt: succeeded || workflow.status === "FAILED" ? new Date().toISOString() : undefined,
          checkpoint: { ...(task.checkpoint || {}), ...(workflow.checkpoint || {}) },
          error: workflow.error?.message,
          result: JSON.stringify({ workflow }),
          metadata: { ...(task.metadata || {}), workflow },
        });
        this.emit("taskUpdated", updated);
        this.emit(succeeded ? "taskCompleted" : "taskFailed", updated);
        return;
      }

      const callSpec = await this.extractCallFromTask(task);
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.cancelBeforeExecution(task);
        return;
      }
      if (!callSpec) {
        await updateTask(task.taskId, { status: 'failed', completedAt: new Date().toISOString(), error: 'No call spec' });
        return;
      }

      // Autonomy Level 4 Guard
      if (AUTONOMY_LEVEL < 4 && DANGEROUS_TOOLS.includes(callSpec.tool)) {
        console.log(`[TaskRunner] Autonomy Level Guard: Requires confirmation for ${callSpec.tool}`);
        await updateTask(task.taskId, { status: 'awaiting_confirmation', updatedAt: new Date().toISOString() });
        this.emit('taskUpdated', task);
        return;
      }

      console.log(`TASK_RUN start ${task.taskId} tool=${callSpec.tool}`);
      try {
        console.log(`[TaskRunner] callSpec for ${task.taskId} = ${JSON.stringify(callSpec)}`);
      } catch {}

      // If callSpec.args is empty, try to read the original tool call from disk
      // (data/tool_calls.json) to grab any provided args (phone/message).
      try {
        if ((!callSpec.args || Object.keys(callSpec.args || {}).length === 0)) {
          const tcRaw = await fs.readFile(dataFile('tool_calls.json'), 'utf-8');
          const tcList = JSON.parse(tcRaw || '[]');
          const matches = tcList.filter((c: any) => c.taskId === task.taskId && c.args && Object.keys(c.args || {}).length > 0);
          if (matches && matches.length) {
            // pick the most recent with args
            matches.sort((a: any, b: any) => (a.timestamp < b.timestamp ? 1 : -1));
            callSpec.args = matches[0].args || {};
          }
        }
      } catch (e) {
        // best-effort; continue with existing callSpec
      }

      // If args are still empty, poll briefly for up to ~5s to allow race conditions
      // where the task metadata or tool_calls entry is written right after task creation.
      if (!callSpec.args || Object.keys(callSpec.args || {}).length === 0) {
        const maxPoll = 10;
        for (let i = 0; i < maxPoll; i++) {
          if (this.stopRequestedTaskIds.has(task.taskId)) {
            await this.cancelBeforeExecution(task);
            return;
          }
          await this.sleep(500);
          if (this.stopRequestedTaskIds.has(task.taskId)) {
            await this.cancelBeforeExecution(task);
            return;
          }
          try {
            const all = await loadTasks();
            const fresh = all.find((t: any) => t.taskId === task.taskId);
            if (fresh && fresh.metadata && fresh.metadata.args && Object.keys(fresh.metadata.args || {}).length) {
              callSpec.args = fresh.metadata.args;
              break;
            }
            const tcRaw = await fs.readFile(dataFile('tool_calls.json'), 'utf-8');
            const tcList = JSON.parse(tcRaw || '[]');
            const matches = tcList.filter((c: any) => c.taskId === task.taskId && c.args && Object.keys(c.args || {}).length > 0);
            if (matches && matches.length) {
              matches.sort((a: any, b: any) => (a.timestamp < b.timestamp ? 1 : -1));
              callSpec.args = matches[0].args || {};
              break;
            }
          } catch {}
        }
      }

      // Inject taskId into the agent args so the desktop agent can report progress
      // Gather a deterministic originalArgs from disk as a fallback
      let originalArgs = callSpec.args || {};
      try {
        const tcRaw2 = await fs.readFile(dataFile('tool_calls.json'), 'utf-8');
        const tcList2 = JSON.parse(tcRaw2 || '[]');
        const firstWithArgs = tcList2.find((c: any) => c.taskId === task.taskId && c.args && Object.keys(c.args || {}).length > 0);
        if (firstWithArgs) originalArgs = firstWithArgs.args || originalArgs;
      } catch {}

      const argsWithContext = Object.assign({}, originalArgs || {}, { taskId: task.taskId });
      if (callSpec.tool === "saraAppExecuteGoal" || callSpec.tool === "saraVoiceExecuteCommand") {
        argsWithContext.automation_task_id = task.taskId;
      }
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.cancelBeforeExecution(task);
        return;
      }
      const toolStartedAt = new Date().toISOString();
      toolDispatchStarted = true;
      const res = await this.callDesktopAgent(callSpec.tool, argsWithContext, originalArgs || {});
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.pauseForEmergencyStop(task, { tool: callSpec.tool, result: res });
        return;
      }

      // Handle policy-driven user approval requirement
      if (!res.ok && res.error === "WAITING_FOR_APPROVAL") {
        // Mark task as awaiting user confirmation
        await updateTask(task.taskId, { status: 'awaiting_confirmation', updatedAt: new Date().toISOString() });
        this.emit('taskUpdated', task);
        // Exit early; will be resumed after user approval
        return;
      }

      // Perform tool-specific verification
      let verification: VerificationResult;
      if (FILESYSTEM_TOOLS.has(callSpec.tool)) {
        verification = await verifyFileOperation(callSpec.tool, originalArgs || (callSpec.args || {}), res);
      } else if (callSpec.tool.includes('browser') || callSpec.tool.includes('open') || callSpec.tool.includes('search') || callSpec.tool.includes('navigate')) {
        verification = await verifyBrowserOperation(callSpec.tool, originalArgs || (callSpec.args || {}), res);
      } else {
        const canonical = (res?.result && typeof res.result === 'object') ? res.result : undefined;
        const explicitlyVerified = canonical?.verified === true || String(canonical?.verification_status || '').toUpperCase() === 'VERIFIED';
        verification = {
          attempted: true,
          passed: Boolean(res && res.ok && explicitlyVerified),
          method: explicitlyVerified ? 'tool_response_validation' : 'explicit_tool_verification_required',
          checks: [
            {
              name: 'tool_returned_ok',
              passed: Boolean(res && res.ok),
              evidence: { toolName: callSpec.tool, result: res?.result },
            },
            { name: 'tool_explicitly_verified', passed: explicitlyVerified, reason: explicitlyVerified ? undefined : 'Execution was dispatched but its postcondition was not verified.' },
          ],
          details: res && res.ok && explicitlyVerified ? 'Tool returned explicit verification evidence.' : (res?.error || 'Tool executed without verified postcondition.'),
        };
      }

      const finalResult = buildStructuredExecutionResult(task.taskId, task.description, toolStartedAt, callSpec.tool, originalArgs || (callSpec.args || {}), res, verification);
      // Log the tool call using the original args that were intended (avoid
      // propagating the `taskId`-only payload entries seen earlier).
      await logToolCall(task.conversationId, callSpec.tool, originalArgs || (callSpec.args || {}), finalResult, res.error, task.taskId);
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        await this.pauseForEmergencyStop(task, finalResult);
        return;
      }

      if (finalResult.success) {
        if (["saraAppExecuteGoal", "saraVoiceExecuteCommand"].includes(callSpec.tool) && hasAutoCloseRequest(res?.result)) {
          try {
            const closeOutcome = await this.callDesktopAgent("closeLaunchedApplications", {
              automation_task_id: task.taskId,
              taskId: task.taskId,
            });
            finalResult.autoClose = summarizeAutoCloseOutcome(closeOutcome);
          } catch (cleanupError) {
            finalResult.autoClose = {
              ok: false,
              verified: false,
              status: "left_open",
              closed: [],
              left_open: [],
              result: `The task succeeded, but graceful app cleanup could not be verified; the app was left open. ${String(cleanupError)}`,
            };
          }
          if (finalResult.autoClose?.verified !== true) {
            finalResult.userMessage = `${finalResult.userMessage || finalResult.summary} The task succeeded, but SARA left the app open because a graceful close could not be verified.`;
          }
        }
        if (this.stopRequestedTaskIds.has(task.taskId)) {
          await this.pauseForEmergencyStop(task, finalResult);
          return;
        }
        const updated = await updateTask(task.taskId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          result: JSON.stringify(finalResult),
          metadata: { ...(task.metadata || {}), taskExecutionResult: finalResult, authoritative: true },
        });
        this.emit('taskUpdated', updated);
        this.emit('taskCompleted', updated);
        sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, tool: callSpec.tool, action: 'execute', result: 'success', verification: finalResult.verified ? 'verified' : 'unverified' });
      } else {
        const updated = await updateTask(task.taskId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: finalResult.error?.message || res?.error || 'Operation failed',
          result: JSON.stringify(finalResult),
          metadata: { ...(task.metadata || {}), taskExecutionResult: finalResult, authoritative: true },
        });
        this.emit('taskUpdated', updated);
        this.emit('taskCompleted', updated);
        sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, tool: callSpec.tool, action: 'execute', result: 'failure', verification: finalResult.verified ? 'verified' : 'unverified', error: finalResult.error?.message });
      }
    } catch (e: any) {
      if (this.stopRequestedTaskIds.has(task.taskId)) {
        if (toolDispatchStarted) await this.pauseForEmergencyStop(task, { error: String(e?.message || e) });
        else await this.cancelBeforeExecution(task);
      } else {
        const failed = await updateTask(task.taskId, { status: 'failed', completedAt: new Date().toISOString(), error: String(e) });
        this.emit('taskUpdated', failed);
        this.emit('taskCompleted', failed);
        console.error(`TASK_RUN error ${task.taskId} ${e?.message || e}`);
        sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, action: 'execute', result: 'exception', error: String(e) });
      }
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.activeTaskIds.delete(task.taskId);
      this.stopRequestedTaskIds.delete(task.taskId);
    }
  }

  private async extractCallFromTask(task: any) {
    if (task.metadata && task.metadata.tool) return { tool: task.metadata.tool, args: task.metadata.args || {} };

    try {
      let calls = await loadToolCalls();
      let forTask = calls.filter((c: any) => c.taskId === task.taskId);
      if ((!forTask || !forTask.length) && dataFile) {
        try {
          const raw = await fs.readFile(dataFile('tool_calls.json'), 'utf-8');
          const parsed = JSON.parse(raw || '[]');
          forTask = parsed.filter((c: any) => c.taskId === task.taskId);
        } catch {}
      }
      if (forTask && forTask.length) {
        const sorted = forTask.sort((a: any, b: any) => (a.timestamp < b.timestamp ? 1 : -1));
        const withArgs = sorted.find((c: any) => c.args && Object.keys(c.args || {}).length > 0);
        const chosen = withArgs || sorted[0];
        return { tool: chosen.toolName, args: chosen.args || {} };
      }
    } catch (e) {}

    const route = inferTaskToolCall(task);
    const desc = (task.description || '').toLowerCase();
    const isWebsiteTask = /(youtube|google|gmail|github|chatgpt|instagram|docs|wikipedia|amazon|netflix|spotify|website|search|open\s+(?:site|page)|visit)/i.test(task.description || "");

    if (isWebsiteTask || route.tool !== 'saraAgentExecute') {
      console.log(`[TaskRunner] Routing to explicit website/browser task for: ${desc}`);
      return route;
    }

    console.log(`[TaskRunner] Routing to DEEP planner for: ${desc}`);
    let plan: any[] | null = null;
    try {
      plan = await this.generateDeepPlan(task.description);
    } catch (err) {
      console.error(`[TaskRunner] Deep Plan generation failed`, err);
    }
    return { tool: 'saraAgentExecute', args: { goal: task.description, priority: task.priority, plan } };
  }

  private async generateDeepPlan(goal: string): Promise<any[] | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;

    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
    const prompt = `You are SARA's Deep Planner Agent. Break down the user's goal into a JSON array of sub-tasks.
Available Agents: browser_agent, coding_agent, os_agent, system_control_agent, application_agent, vision_agent.
Each task must have: 'agent', 'action', 'args' (object), 'parallel' (boolean), and optionally 'checkpoint' (string name), 'depends_on' (array of checkpoint strings).

User Goal: ${goal}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              agent: { type: Type.STRING },
              action: { type: Type.STRING },
              args: { type: Type.OBJECT },
              parallel: { type: Type.BOOLEAN },
              checkpoint: { type: Type.STRING },
              depends_on: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ['agent', 'action', 'args', 'parallel']
          }
        }
      }
    });

    const resultText = response.text?.trim() || '[]';
    return JSON.parse(resultText);
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

let _runner: TaskRunner | null = null;

export function initTaskRunner(callAgent?: typeof defaultCallDesktopAgent) {
  if (_runner) return _runner;
  _runner = new TaskRunner(callAgent as any);
  return _runner;
}

export function getTaskRunner() {
  return _runner;
}

export async function reportTaskProgress(taskId: string, progress: Record<string, unknown>) {
  if (!_runner) return null;
  return await _runner.reportProgress(taskId, progress);
}

export default initTaskRunner;
