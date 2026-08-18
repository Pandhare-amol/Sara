import EventEmitter from 'events';
import { loadTasks, updateTask, loadToolCalls } from './server_state';
import fs from 'fs/promises';
import fsSync from 'fs';
import { dataFile } from './server_paths';
import { callDesktopAgent as defaultCallDesktopAgent, logToolCall } from './desktop_agent_bridge';
import { sysLogger } from './server_logger';
import { GoogleGenAI, Type } from '@google/genai';
import { createUserResponseFromResult } from './src/types/AuthoritativeTaskResult';
import type { AuthoritativeTaskResult, ExecutionState, VerificationResult, ExecutionError } from './src/types/AuthoritativeTaskResult';

const AUTONOMY_LEVEL = parseInt(process.env.AUTONOMY_LEVEL || '3');

type TaskStatus = 'queued' | 'planning' | 'running' | 'waiting' | 'paused' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'RECOVERING' | 'awaiting_confirmation' | 'partial' | 'timed_out' | 'blocked' | 'succeeded';

const DANGEROUS_TOOLS = ['os.shutdown', 'files.delete', 'communication.bulk_send'];

/**
 * Build a verification result for file operations.
 * Checks if source exists, destination was created, and optionally compares size/hash.
 */
async function verifyFileOperation(
  tool: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; error?: string }
): Promise<VerificationResult> {
  const checks = [];
  let passed = outcome.ok;

  try {
    if (tool === 'copyFile' || tool === 'moveFile') {
      const source = String(args.source || '');
      const destination = String(args.destination || '');

      // Check source exists
      const sourceExists = fsSync.existsSync(source);
      checks.push({ name: 'source_exists', passed: sourceExists, evidence: { path: source } });
      passed = passed && sourceExists;

      // Check destination exists after operation
      const destExists = fsSync.existsSync(destination);
      checks.push({ name: 'destination_exists', passed: destExists, evidence: { path: destination } });
      passed = passed && destExists;

      // For copy, both should exist. For move, only destination.
      if (tool === 'moveFile') {
        const sourceGone = !fsSync.existsSync(source);
        checks.push({ name: 'source_removed', passed: sourceGone, evidence: { path: source } });
        passed = passed && sourceGone;
      }
    }
  } catch (e: any) {
    checks.push({ name: 'verification_check_failed', passed: false, reason: String(e) });
    passed = false;
  }

  return {
    attempted: true,
    passed,
    method: 'file_system_verification',
    checks,
    details: passed ? 'File operation verified' : `File operation failed verification: ${checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`,
  };
}

/**
 * Build a verification result for browser operations.
 */
async function verifyBrowserOperation(
  tool: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; error?: string }
): Promise<VerificationResult> {
  const checks = [];
  let passed = outcome.ok;

  try {
    checks.push({
      name: 'browser_tool_returned_ok',
      passed: passed,
      evidence: { tool, outcome: outcome.ok },
    });
  } catch (e: any) {
    checks.push({ name: 'browser_verification_check_failed', passed: false, reason: String(e) });
    passed = false;
  }

  return {
    attempted: true,
    passed: Boolean(outcome.ok),
    method: 'browser_outcome_verification',
    checks,
    details: outcome.ok ? 'Browser operation completed' : (outcome.error || 'Browser operation failed'),
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
  const verificationPassed = verification?.passed === true;
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
    verified: verification?.passed === true,
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

export type { AuthoritativeTaskResult, VerificationResult };

class TaskRunner extends EventEmitter {
  private concurrency = 2;
  private running = 0;
  private queueWake = false;
  private stopped = false;
  private callDesktopAgent: (tool: string, args: Record<string, unknown>, originalArgs?: Record<string, unknown>) => Promise<any>;

  constructor(callAgent?: typeof defaultCallDesktopAgent) {
    super();
    this.callDesktopAgent = callAgent || defaultCallDesktopAgent;
    void this.loop();
  }

  public async wake() {
    this.queueWake = true;
  }

  // Report progress for a running task: updates checkpoint and emits progress
  public async reportProgress(taskId: string, progress: Record<string, unknown>) {
    try {
      const updated = await updateTask(taskId, { checkpoint: progress, updatedAt: new Date().toISOString() } as any);
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

  private async pickNextTasks(): Promise<any[]> {
    try {
      const tasks = await loadTasks();
      const candidates = tasks.filter((t) => t.status === "queued" || t.status === "planning" || t.status === "RECOVERING" || t.status === "retrying");
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
    this.running += 1;
    try {
      const started = await updateTask(task.taskId, { status: 'running', startedAt: new Date().toISOString() });
      this.emit('taskUpdated', started);
      this.emit('taskStarted', started);

      // Reload the task record from storage in case metadata/tool args were
      // updated after the in-memory task snapshot was taken.
      try {
        const all = await loadTasks();
        const fresh = all.find((t: any) => t.taskId === task.taskId);
        if (fresh) task = fresh;
      } catch {}

      const callSpec = await this.extractCallFromTask(task);
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
          await this.sleep(500);
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
      const toolStartedAt = new Date().toISOString();
      const res = await this.callDesktopAgent(callSpec.tool, argsWithContext, originalArgs || {});

      // Perform tool-specific verification
      let verification: VerificationResult;
      if (callSpec.tool.includes('copy') || callSpec.tool.includes('move') || callSpec.tool.includes('delete') || callSpec.tool.includes('File')) {
        verification = await verifyFileOperation(callSpec.tool, originalArgs || (callSpec.args || {}), res);
      } else if (callSpec.tool.includes('browser') || callSpec.tool.includes('open') || callSpec.tool.includes('search') || callSpec.tool.includes('navigate')) {
        verification = await verifyBrowserOperation(callSpec.tool, originalArgs || (callSpec.args || {}), res);
      } else {
        verification = {
          attempted: true,
          passed: Boolean(res && res.ok && res.result !== undefined),
          method: 'tool_response_validation',
          checks: [
            {
              name: 'tool_returned_ok',
              passed: Boolean(res && res.ok),
              evidence: { toolName: callSpec.tool, result: res?.result },
            },
          ],
          details: res && res.ok ? 'Tool reported success and returned a result payload.' : (res?.error || 'Tool reported failure.'),
        };
      }

      const finalResult = buildStructuredExecutionResult(task.taskId, task.description, toolStartedAt, callSpec.tool, originalArgs || (callSpec.args || {}), res, verification);
      // Log the tool call using the original args that were intended (avoid
      // propagating the `taskId`-only payload entries seen earlier).
      await logToolCall(task.conversationId, callSpec.tool, originalArgs || (callSpec.args || {}), finalResult, res.error, task.taskId);

      if (finalResult.success) {
        const updated = await updateTask(task.taskId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          result: JSON.stringify(finalResult),
          metadata: { ...(task.metadata || {}), taskExecutionResult: finalResult, authoritative: true },
        });
        this.emit('taskUpdated', updated);
        this.emit('taskCompleted', updated);
        sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, tool: callSpec.tool, action: 'execute', result: 'success', verified: finalResult.verified });
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
        sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, tool: callSpec.tool, action: 'execute', result: 'failure', verified: finalResult.verified, error: finalResult.error?.message });
      }
    } catch (e: any) {
      const failed = await updateTask(task.taskId, { status: 'failed', completedAt: new Date().toISOString(), error: String(e) });
      this.emit('taskUpdated', failed);
      this.emit('taskCompleted', failed);
      console.error(`TASK_RUN error ${task.taskId} ${e?.message || e}`);
      sysLogger.log({ component: 'TaskRunner', task_id: task.taskId, action: 'execute', result: 'exception', error: String(e) });
    } finally {
      this.running = Math.max(0, this.running - 1);
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

    // Fast vs Deep Routing
    const desc = (task.description || '').toLowerCase();
    const isFast = /^(open|close|type|click|search|play|pause|mute|unmute|volume)/.test(desc);
    
    if (isFast) {
      console.log(`[TaskRunner] Routing to FAST execution for: ${desc}`);
      return { tool: 'saraUniversalCommand', args: { command: task.description } };
    } else {
      console.log(`[TaskRunner] Routing to DEEP planner for: ${desc}`);
      let plan: any[] | null = null;
      try {
        plan = await this.generateDeepPlan(task.description);
      } catch (err) {
        console.error(`[TaskRunner] Deep Plan generation failed`, err);
      }
      return { tool: 'saraAgentExecute', args: { goal: task.description, priority: task.priority, plan } };
    }
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
