import express from "express";
import crypto from "crypto";
import http from "http";
import path from "path";
import { spawn, execSync } from "child_process";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import * as fs from "fs";
import { 
  loadMemories, 
  saveMemories, 
  formatSystemInstructionsWithMemories, 
  processConversationSlice,
  searchMemories,
  upsertMemory
} from "./server_memory";
import { gatherBuildIdentity, loadBuildManifest } from "./src/security/buildIdentity";
import { AuditLogger } from "./src/security/auditLogger";
import cognitiveRoutes from "./src/cognitive/routes";
import { ToolRouter } from "./src/core/tools/toolRouter";
import { initializeToolExecution, getExecutionOrchestrator } from "./src/core/tools/initialization";
import { AutomationOrchestrator, isAsyncAutomationTool } from "./src/core/automation/automationOrchestrator";
import { handleLocalMemoryCommand } from "./src/services/localMemoryCommands";
import { evaluateRetryPolicy } from "./src/core/tools/retryPolicy";
import { SARA_VOICE_PROFILE, getSaraMode, setSaraMode, getModeInstructions } from "./src/config/saraProfile";

const SARA_SYSTEM_PROMPT_BASE = `You are Sara, a young Indian female AI personal assistant aged 20 to 25.
Speak with a naturally feminine, soft, warm, and intelligent voice.
Keep your tone calm, clear, confident, and emotionally aware.
Sound like a real young Indian woman having a natural conversation.
Use natural Indian English pronunciation that is internationally understandable.
Avoid sounding robotic, overly dramatic, childlike, or like a generic virtual assistant.

Always remain consistent in voice, personality, and warmth across the conversation.
You are intelligent, helpful, respectful, slightly playful, and proactive.
When speaking, be gentle, pleasant, smooth, and slightly expressive.
Never over-pronounce punctuation or read text mechanically.

For simple commands, reply with a short, direct spoken acknowledgement.
For more complex tasks, acknowledge quickly and provide progress updates only when useful.
If a task succeeds, say it clearly and briefly.
If an error happens, be gentle, honest, and reassuring.

Use natural pacing and phrasing with appropriate pauses between thoughts.
Do not sound like a call-center operator, GPS voice, news reader, or generic assistant.
Keep your responses warm, modern, and believable as SARA, the young Indian AI assistant.
`;
/*
  Additional human-safety and response guidance omitted here.
  The original repository included guidance and safety boundaries
  for SARA's conversational behavior; those are preserved in
  external documentation rather than inlining them in this runtime
  TypeScript file to avoid parse issues.
*/
import type { Memory, MemoryCategory } from "./src/lib/memoryTypes";
import {
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
} from "./server_paths";
import {
  ConversationMessage,
  ConversationRecord,
  SessionRecord,
  TaskRecord,
  ConversationRole,
  newMessageId,
  newSessionId,
  newToolCallId,
  appendConversationMessage,
  getOrCreateConversation,
  loadSessions,
  loadTasks,
  loadUnfinishedTasks,
  getLastSession,
  getRecentConversationMessages,
  upsertSession,
  createTask,
  updateTask,
  deleteTask,
  appendToolCall,
  appendAuditEvent,
} from "./server_state";
import * as whatsappClient from './src/whatsapp_client';
import { redactSecrets } from './src/security/auditLogger';

dotenv.config();

// ---------------------------------------------------------------------------
// SARA V2 â€” Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* already exists */ }

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog("commands.log", m);
const logStartup = (m: string) => appendLog("startup.log", m);
const logError = (m: string) => appendLog("errors.log", m);

// Security subsystems initialized at startup

const SARA_SYSTEM_PROMPT_PATH = path.join(process.cwd(), "SARA_SYSTEM_PROMPT.md");

function loadSaraSystemPrompt(): string {
  try {
    if (fs.existsSync(SARA_SYSTEM_PROMPT_PATH)) {
      return fs.readFileSync(SARA_SYSTEM_PROMPT_PATH, "utf-8");
    }
  } catch {
    // fallback to embedded prompt below
  }
  return SARA_SYSTEM_PROMPT_BASE;
}

// ---------------------------------------------------------------------------
// SARA Desktop Control Agent â€” HTTP bridge to the Python FastAPI backend.
// ---------------------------------------------------------------------------
const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
const DESKTOP_AGENT_TIMEOUT = 25_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications / websites / search
  "openApplication", "closeApplication", "openWebsite",
  "searchWeb", "searchYouTube", "searchGoogle", "searchGitHub",
  // files
  "createFile", "readFile", "renameFile", "deleteFile", "moveFile",
  "openFolder", "listFiles", "searchFiles",
  // pc control (volume + gated power)
  "volumeUp", "volumeDown", "muteToggle", "setVolume",
  "requestPowerAction", "executePowerAction",
  // windows
  "minimizeWindow", "maximizeWindow", "closeWindow", "switchApplication",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen",
  // browser automation (Playwright â€” desktop-owned, separate from holographic UI)
  "desktopBrowserOpen", "desktopBrowserNavigate", "desktopBrowserOpenTab",
  "desktopBrowserCloseTab", "desktopBrowserSearch", "desktopBrowserClick",
  "desktopBrowserState", "desktopBrowserExtractLinks",
    "desktopBrowserMediaState",
    "desktopLiveState",
  "desktopBrowserType", "desktopBrowserFillForm", "desktopBrowserGoBack",
  "desktopBrowserGoForward", "desktopBrowserScroll",
  // coding assistance
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  // system information
  "systemInfo", "gpuInfo", "temperatureInfo",
  // brightness control (V2)
  "brightnessUp", "brightnessDown", "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
  // Screen monitoring / live capture
  "saraScreenMonitorStart", "saraScreenMonitorStop", "saraScreenMonitorStatus",
  "saraScreenMonitorSample", "saraScreenLiveStart", "saraScreenLiveStop", "saraScreenLiveStatus",
  // Android companion suite
  "saraAndroidPair", "saraAndroidPlan", "saraAndroidExecute",
  // Multi-agent & system orchestration tools
  "saraAgentExecute", "saraAgentEmergencyStop", "saraMemoryRemember",
  "saraMemorySearch", "saraRagIndex", "saraRagRetrieve", "saraSecurityAssess",
  "saraProactiveEvaluate", "saraProactiveRecordOutcome", "saraEmotionalState", "saraQuietMode",
]);

/**
 * Call the Python desktop agent.  Returns the parsed JSON response.
 * If the agent is unreachable, returns a user-friendly error payload.
 */
/**
 * Whether the desktop agent has been confirmed alive in this process lifetime.
 * If false, callDesktopAgent will probe /health and attempt an auto-spawn.
 */
let desktopAgentVerified = false;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Looks for the project's bundled Python interpreter first,
 * falling back to `python` / `python3` on PATH. Runs detached so it survives
 * even if SARA's node process is killed.
 */
function spawnDesktopAgent(): void {
  if (process.env.SARA_SUPERVISOR) {
    console.log("[Desktop Agent] Supervisor present — skipping auto-spawn.");
    return;
  }
  const agentEnv = {
    ...process.env,
    SARA_AGENT_HOST: "127.0.0.1",
    SARA_AGENT_PORT: "8765",
    SARA_DATA_DIR: DATA_DIR,
  };

  // Preferred path (packaged app): a PyInstaller-frozen agent exe that embeds
  // its own Python runtime. Set by the Electron main process via SARA_AGENT_EXE.
  const frozenExe = process.env.SARA_AGENT_EXE;
  if (frozenExe && fs.existsSync(frozenExe)) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: "ignore",
        windowsHide: true, // never flash a console window
        env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e: any) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  const candidates = [
    process.env.SARA_PYTHON,
    "C:\\Users\\MSI\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn("[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.");
    logError("AGENT_SPAWN_NO_RUNTIME: neither SARA_AGENT_EXE nor Python available");
    return;
  }
  try {
    const child = spawn(
      py,
      ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true, env: agentEnv }
    );
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`);
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
async function isDesktopAgentAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the desktop agent is running. If not verified yet, probe health; if
 * down, auto-spawn and poll until it is ready (or timeout).
 */
async function ensureDesktopAgent(): Promise<void> {
  if (desktopAgentVerified) return;
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    console.log("[Desktop Agent] Already running — 52 tools available.");
    return;
  }
  if (process.env.SARA_SUPERVISOR) {
    console.log("[Desktop Agent] Supervisor present — not auto-starting; agent may be managed externally.");
    return;
  }
  console.log("[Desktop Agent] Not detected. Auto-starting...");
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Online after ${i}s â€” 52 tools available.`);
      return;
    }
  }
  console.warn("[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.");
}

async function callDesktopAgentTransport(
  tool: string,
  args: Record<string, unknown>,
  originalArgs?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Server-side shortcut for WhatsApp operations so TaskRunner can execute
  // whatsapp-related tasks without relying on the Desktop Agent process.
  try {
    const t = String(tool || '').toLowerCase();
    if (t === 'whatsappsend' || t === 'whatsapp.send' || t === 'whatsapp_send' || t === 'whatsappsend') {
      const to = String((args || {})['to'] || (args || {})['phone'] || '');
      const text = String((args || {})['text'] || (args || {})['message'] || '');
      if (!to || !text) return { ok: false, error: 'Missing to/text for whatsapp send' };
      try {
        const result = await whatsappClient.sendTextMessage(to, text, String(originalArgs?.['taskId'] || args?.['taskId'] || ''));
        return { ok: true, result };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    if (t === 'whatsappincoming' || t === 'whatsapp.incoming' || t === 'whatsapp_incoming') {
      try {
        await Promise.resolve(whatsappClient.persistIncomingEvent(args || {}));
        return { ok: true, result: 'persisted' };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    if (t === 'whatsappsuggest' || t === 'whatsapp.suggest' || t === 'whatsapp_suggest') {
      try {
        const message = (args || {})['message'] || (args || {})['text'] || '';
        const from = String((args || {})['from'] || (args || {})['phone'] || '');
        let suggestion = 'Thanks — I received your message.';
        const raw = String(message || '');
        if (raw.includes('?')) suggestion = "I'll check on that and get back to you shortly.";
        else if (raw.toLowerCase().includes('price') || raw.toLowerCase().includes('cost')) suggestion = 'I can check pricing and reply shortly.';

        // If Gemini API is configured, generate higher-quality suggestions using the LLM
        try {
          const useGemini = typeof hasGeminiApiKey === 'function' ? hasGeminiApiKey() : false;
          if (useGemini) {
            try {
              const apiKey = getGeminiApiKey();
              const history = [{ role: 'user', text: raw }];
              const prompt = `You are SARA. Propose three short, friendly WhatsApp reply options (1-2 short sentences each) to the user's incoming message. Return the three replies separated by the token ||| with no additional commentary.`;
              const aiText = await generateSaraChatResponse(apiKey, history, prompt, 'desktop');
              if (aiText && aiText.trim()) {
                const parts = aiText.split('|||').map((s: string) => s.trim()).filter((s: string) => s.length);
                if (parts.length) {
                  suggestion = parts[0];
                  // Persist multiple suggestions in conversation metadata if possible
                  try {
                    if (from) {
                      const conv = await getOrCreateConversation(String(from));
                      const metaMsg = { id: newMessageId(), conversationId: conv.id, role: 'assistant', content: `Suggestions: ${parts.slice(0,3).join(' ||| ')}`, timestamp: new Date().toISOString(), metadata: { suggested: true, source: 'whatsapp', suggestions: parts.slice(0,3) } };
                      await appendConversationMessage(metaMsg as any);
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {
              console.warn('[whatsappsuggest] Gemini suggestion failed, falling back to canned logic', e);
            }
          }
        } catch (e) {}

        // Optionally persist suggestion into the conversation as a suggested reply
        try {
          if (from) {
            const conv = await getOrCreateConversation(String(from));
            const msgRec = { id: newMessageId(), conversationId: conv.id, role: 'assistant', content: suggestion, timestamp: new Date().toISOString(), metadata: { suggested: true, source: 'whatsapp' } };
            await appendConversationMessage(msgRec as any);
          }
        } catch (e) {}

        // Auto-send if requested: enqueue a tracked Task instead of sending
        if ((args || {})['autoSend']) {
          const to = from || String((args || {})['to'] || '');
          if (to) {
            try {
              const sendTask = await createTask({ conversationId: conv.id, description: `whatsapp: send suggested reply to ${to}`, assignedAgent: 'whatsapp_agent', metadata: { tool: 'whatsappSend', args: { to, text: suggestion } } });
              try { await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: conv.id, toolName: 'whatsappSend', args: { to, text: suggestion }, taskId: sendTask.taskId, timestamp: new Date().toISOString() }); } catch {}
              // Wake TaskRunner to pick up the send task
              try { const { getTaskRunner } = await import('./server_task_manager'); getTaskRunner()?.wake(); } catch (e) {}
              return { ok: true, result: { suggestion, queuedTaskId: sendTask.taskId } };
            } catch (e: any) {
              return { ok: false, error: String(e?.message || e) };
            }
          }
        }

        return { ok: true, result: { suggestion } };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
  } catch (e) {
    // ignore and fall back to Desktop Agent HTTP call below
  }
  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }

  let attempt = 0;
  while (attempt < 2) {
    try {
      logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);

      const payload: any = { tool, args };
      if (originalArgs && Object.keys(originalArgs).length) payload.original_args = originalArgs;

      const bodyText = JSON.stringify(payload);
      // Persist the outgoing payload for forensic debugging in logs/agent_payloads.log
      try {
        appendLog(`AGENT_PAYLOAD ${bodyText}`);
      } catch (e) {}
      const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Debug: log the exact payload we sent to the desktop agent
      try {
        console.log(`[Desktop Agent] POST /execute -> ${DESKTOP_AGENT_URL}/execute body=${JSON.stringify(payload)}`);
      } catch {}

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0,200)}`);
        return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
      }
      return await res.json();
    } catch (err: any) {
      desktopAgentVerified = false; // mark stale so next call retries the spawn
      const msg = err?.name === "AbortError"
        ? "Desktop agent timed out."
        : "Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765";
      logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);

      if (attempt === 0) {
        console.log(`[Desktop Agent] Agent unreachable for ${tool}; retrying startup.`);
        await ensureDesktopAgent();
        attempt += 1;
        continue;
      }

      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: "Desktop agent could not be reached after retry." };
}

const desktopToolRouter = new ToolRouter({
  isKnownTool: (tool) => DESKTOP_TOOLS.has(tool),
});
desktopToolRouter.registry.registerRuntimeTools(DESKTOP_TOOLS, {
  version: "1.0",
  supportsCancellation: false,
  allowedContexts: ["voice", "chat", "task", "api"],
});
desktopToolRouter.setAdapter((tool, args) =>
  callDesktopAgentTransport(tool, args, args.original_args as Record<string, unknown> | undefined),
);

// Initialize Phase 3 execution orchestrator with verification
const executionOrchestrator = initializeToolExecution(desktopToolRouter, DESKTOP_AGENT_URL);
async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
  originalArgs?: Record<string, unknown>,
) {
  const routedArgs = originalArgs ? { ...args, original_args: originalArgs } : args;
  const unified = await executionOrchestrator.executeWithVerification(tool, routedArgs);
  const executionPayload = unified.executionResult ?? { result: unified.message };
  return {
    ok: unified.success,
    result: unified.success ? executionPayload : unified,
    error: unified.success ? undefined : unified.message,
    canonical: unified,
    unified,
  };
}

const automationOrchestrator = new AutomationOrchestrator(async (tool, args) => {
  const result = await callDesktopAgent(tool, args);
  if (!result.ok) {
    throw new Error(result.error || `Automation failed for ${tool}`);
  }
  return result.result;
});

const automationPersistence = new Map<string, Promise<void>>();
const priorityNumber: Record<string, number> = { CRITICAL: 1, HIGH: 2, NORMAL: 5, LOW: 7, BACKGROUND: 9 };

function persistAutomationEvent(event: { type: string; task: any }): void {
  const task = event.task;
  const previous = automationPersistence.get(task.task_id) || Promise.resolve();
  const next = previous.then(async () => {
    const now = new Date().toISOString();
    const metadata = {
      automation: true,
      tool: task.tool,
      args: redactSecrets(task.args),
      priority: task.priority,
      sessionId: task.sessionId,
      conversationId: task.conversationId,
    };
    if (event.type === "automation:queued") {
      const existing = (await loadTasks()).find((item) => item.taskId === task.task_id);
      if (!existing) {
        await createTask({
          taskId: task.task_id,
          conversationId: task.conversationId || "automation",
          description: `${task.tool} background automation`,
          priority: priorityNumber[task.priority] || 5,
          assignedAgent: "AutomationOrchestrator",
          metadata,
        });
      }
      return;
    }
    const status = task.status === "COMPLETED"
      ? "completed"
      : task.status === "CANCELLED"
        ? "cancelled"
        : task.status === "FAILED"
          ? "failed"
          : task.status === "STARTING"
            ? "planning"
            : "running";
    await updateTask(task.task_id, {
      status,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      result: task.result === undefined ? undefined : JSON.stringify(redactSecrets(task.result)),
      error: task.error,
      checkpoint: {
        current_task: task.tool,
        task_progress: task.progress,
        last_action: task.tool,
        recent_summary: task.status,
      },
      metadata,
      updatedAt: now,
    } as any);
  }).catch((error) => {
    logError(`AUTOMATION_PERSISTENCE_FAILED task=${task.task_id}: ${String(error)}`);
  });
  automationPersistence.set(task.task_id, next);
  void next;
}

automationOrchestrator.on(persistAutomationEvent);
void loadUnfinishedTasks().then((tasks) => {
  const restorable = tasks
    .filter((task) => task.metadata?.automation === true && typeof task.metadata?.tool === "string")
    .map((task) => ({
      task_id: task.taskId,
      tool: String(task.metadata?.tool),
      args: (task.metadata?.args || {}) as Record<string, unknown>,
      priority: (task.metadata?.priority || "NORMAL") as any,
      status: undefined,
      progress: Number(task.checkpoint?.task_progress || 0),
      created_at: task.createdAt,
      sessionId: String(task.metadata?.sessionId || "") || undefined,
      conversationId: task.conversationId,
    }));
  automationOrchestrator.restore(restorable);
}).catch((error) => logError(`AUTOMATION_RESTORE_FAILED: ${String(error)}`));

async function callCompanionEndpoint(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; result?: unknown; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);
    const res = await fetch(`${DESKTOP_AGENT_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || data?.detail || "Companion endpoint error" };
    }
    return { ok: true, status: res.status, result: data };
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? "Companion endpoint timed out."
      : "Companion endpoint is not reachable.";
    return { ok: false, status: 502, error: msg };
  }
}

function buildSaraChatPrompt(memories: Memory[], history: { role: string; text: string }[], userText: string, source: "desktop" | "mobile") {
  const promptBase = loadSaraSystemPrompt();
  const baseInstruction =
    source === "mobile"
      ? `${promptBase}\n\nYou are Sara Mobile, an independent mobile companion with a separate memory core from desktop SARA. Speak in a warm, gentle, and helpful mobile companion tone. Keep mobile memories and context separate from the desktop system.`
      : `${promptBase}\n\nYou are Sara, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion. Speak in a gentle, supportive, affectionate tone, using cozy companion language.`;

  const systemInstruction = formatSystemInstructionsWithMemories(baseInstruction, memories);
  const dialogue = history
    .map((entry) => `${entry.role === "assistant" ? "Sara" : "User"}: ${entry.text}`)
    .join("\n");

  return `${systemInstruction}\n\n=== CONVERSATION HISTORY ===\n${dialogue}${dialogue.length ? "\n" : ""}=== END CONVERSATION HISTORY ===\nUser: ${userText}\nSara:`;
}

async function generateSaraChatResponse(
  apiKey: string,
  history: { role: string; text: string }[],
  userText: string,
  source: "desktop" | "mobile",
  relevantMemories: Memory[] = [],
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const memories = relevantMemories.length > 0
    ? relevantMemories
    : (await searchMemories(userText, source, 8)).length > 0
      ? await searchMemories(userText, source, 8)
      : await loadMemories(source);
  const prompt = buildSaraChatPrompt(memories, history.slice(-8), userText, source) + getModeInstructions();
  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: prompt,
    config: {
      maxOutputTokens: 512,
      temperature: 0.7,
    },
  });

  return String(response.text ?? "").trim();
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  if (!Number.isFinite(PORT) || PORT <= 0) {
    throw new Error(`Invalid PORT configuration: ${process.env.PORT}`);
  }

  app.use(express.json());

  // --- Security / Provenance initialization (non-blocking) ---
  try {
    const build = gatherBuildIdentity(process.cwd(), DATA_DIR);
    const audit = new AuditLogger(path.join(DATA_DIR, "security"));
    try { await (await import("./server_state")).saveBuildManifest(build); } catch {}
    audit.append({ event_type: "BUILD_IDENTITY_CREATED", metadata: { build } }).catch(() => {});
    try { await (await import('./server_state')).migrateWebhooksFromSettingsIfNeeded(); } catch {}
  } catch (e) {
    // keep startup resilient; security bookkeeping must not block server
  }

  // --- Wake listener initialization (pluggable) ---
  // Defer wake listener startup until after WebSocket server exists so
  // we can broadcast wake events to connected UI clients immediately.
  let wakeListener: any = null;
  let deferredWakeConfig: any = null;
  try {
    const settings = loadSettingsFile();
    const enabled = Boolean(settings?.wake?.enabled);
    if (enabled) {
      deferredWakeConfig = { settings };
    }
  } catch (e) {}

  function formatConversationPrompt(messages: ConversationMessage[]): string {
    if (messages.length === 0) return "";
    const lines = messages.map((message) => {
      const speaker = message.role === "assistant" ? "Sara" : message.role === "user" ? "User" : message.role === "system" ? "System" : message.role;
      return `${speaker}: ${message.content}`;
    });
    return `\n=== RECENT CONVERSATION CONTEXT ===\n${lines.join("\n")}\n=== END RECENT CONTEXT ===\n`;
  }

  async function createSessionRecord(conversationId: string, sessionId: string, status: SessionRecord["connectionStatus"]): Promise<void> {
    const now = new Date().toISOString();
    await upsertSession({
      sessionId,
      conversationId,
      device: "browser",
      connectionStatus: status,
      createdAt: now,
      lastSeen: now,
      reconnectAttempts: 0,
    });
  }

  // Recover tasks on startup: mark running tasks as RECOVERING and emit audit entries
  try {
    const { loadUnfinishedTasks, setTaskRecovering } = await import('./server_state');
    const unfinished = await loadUnfinishedTasks();
    for (const t of unfinished) {
      if (t.status === 'RUNNING' || t.status === 'PLANNING') {
        await setTaskRecovering(t.taskId);
        const a = new AuditLogger(path.join(DATA_DIR, 'security'));
        a.append({ event_type: 'TASK_RECOVERING', metadata: { taskId: t.taskId, previous_status: t.status }, severity: 'HIGH' }).catch(() => {});
      }
    }
  } catch (e) { console.warn('Task recovery failure', String(e)); }

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "sara-backend",
      service_version: "1.0.0",
      protocol_version: "1"
    });
  });

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      const memories = await loadMemories(source);
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories(source);
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      memories.push(newMemory);
      await saveMemories(memories, source);
      res.status(201).json(newMemory);
        // List pending confirmations (non-sensitive view)
        app.get('/api/confirm/list', async (_req, res) => {
          try {
            const list = await loadConfirmations();
            // redact sensitive fields (hash, salt)
            const safe = list.map((c: any) => ({ id: c.id, action: c.action, args: c.args, taskId: c.taskId || null, expiresAt: c.expiresAt }));
            res.json({ ok: true, confirmations: safe });
          } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
        });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      const { id } = req.params;
      let memories = await loadMemories(source);
      memories = memories.filter((m) => m.id !== id);
      await saveMemories(memories, source);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // V2: Settings API â€” mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile("settings.json");

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch { /* corrupt file â€” return defaults */ }
    return {};
  }

  function saveSettingsFile(data: Record<string, unknown>): void {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  app.get("/api/settings", async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ("autoStart" in patch) {
        // Prefer using Task Scheduler registration on Windows for robust auto-start
        try {
          const enable = Boolean(patch.autoStart);
          if (process.platform === 'win32') {
            const ps = enable ? 'scripts/register-startup.ps1' : 'scripts/unregister-startup.ps1';
            try {
              const p = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', ps], { cwd: process.cwd(), detached: false, stdio: 'ignore' });
              // best-effort: do not await — registration completes quickly
            } catch (e) {}
          } else {
            // Fallback: copy a batch file into user's Startup folder for non-Windows platforms
            try {
              const appdata = process.env.APPDATA || '';
              const startupDir = appdata ? path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null;
              if (startupDir) {
                const src = path.join(process.cwd(), 'start-sara-silent.bat');
                const dest = path.join(startupDir, 'start-sara-silent.lnk.bat');
                if (enable) {
                  try { fs.copyFileSync(src, dest); } catch (e) {}
                } else {
                  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) {}
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
        // Also notify the desktop agent if present
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {})
          .catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const text = String(req.body?.text ?? "").trim();
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const source = req.body?.source === "mobile" ? "mobile" : "desktop";
      if (!text) {
        return res.status(400).json({ error: "Message text is required." });
      }

      const apiKey = getGeminiApiKey();
      if (!apiKey) {
        return res.status(500).json({ error: "Gemini API key is not configured." });
      }

      const normalizedHistory = history
        .map((item: any) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          text: String(item.text ?? "").trim(),
        }))
        .filter((item: any) => item.text.length > 0);

      const relevantMemories = await searchMemories(text, source, 10);
      const reply = await generateSaraChatResponse(apiKey, normalizedHistory, text, source, relevantMemories);
      await processConversationSlice(apiKey, [...normalizedHistory, { role: "user", text }, { role: "assistant", text: reply }], source);
      res.json({ ok: true, text: reply });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to generate chat response." });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists â€” the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => {
    res.json({ hasApiKey: hasGeminiApiKey() });
  });

  app.post("/api/config/apikey", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      // If requesting mobile conversations, require companion auth via headers
      if (source === "mobile") {
        const deviceId = String(req.headers["x-companion-id"] ?? "");
        const token = String(req.headers["x-companion-token"] ?? "");
        const companionsFile = dataFile("companions.json");
        let list: any[] = [];
        try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
        const found = list.find((c) => c.id === deviceId && !c.revoked);
        if (!found) return res.status(401).json({ error: "Invalid companion credentials" });
        if (found.hash && found.salt) {
          const derived = crypto.scryptSync(token, found.salt, 64).toString("hex");
          if (derived !== found.hash) return res.status(401).json({ error: "Invalid companion credentials" });
        } else if (found.token) {
          if (found.token !== token) return res.status(401).json({ error: "Invalid companion credentials" });
          const salt = crypto.randomBytes(16).toString("hex");
          const derived = crypto.scryptSync(found.token, salt, 64).toString("hex");
          delete found.token;
          found.hash = derived;
          found.salt = salt;
          fs.writeFileSync(companionsFile, JSON.stringify(list, null, 2), "utf-8");
        }
      }
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      if (!fs.existsSync(file)) return res.json([]);
      const raw = fs.readFileSync(file, "utf-8");
      const items = raw ? JSON.parse(raw) : [];
      res.json(items);
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });

  // V2: Agent health proxy (for the Settings panel â€” avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get("/api/agent-health", async (_req, res) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post("/api/vision/analyze", async (req, res) => {
    try {
      const dataUrl = String(req.body?.dataUrl ?? "");
      const question = String(req.body?.question ?? "Describe only visible, non-sensitive details.").trim();
      const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) {
        return res.status(400).json({ ok: false, error: "A valid camera image is required." });
      }
      if (match[2].length > 8 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: "Camera image is too large." });
      }

      const apiKey = getGeminiApiKey();
      if (!apiKey) {
        return res.status(503).json({ ok: false, error: "Gemini API key is not configured." });
      }

      const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [{
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase(),
                data: match[2],
              },
            },
            {
              text: `Analyze this camera frame for the user's request: ${question}\nOnly report observable, non-sensitive details such as clothing colors, visible accessories, lighting, framing, posture, and image quality. Do not identify the person or infer health, identity, mood, religion, politics, sexuality, personality, or other sensitive traits. If the image is unclear, say what is missing and suggest a camera adjustment.`,
            },
          ],
        }],
        config: { maxOutputTokens: 300, temperature: 0.2 },
      });

      return res.json({ ok: true, text: String(response.text ?? "").trim() });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || "Vision analysis failed." });
    }
  });

  // Admin: fetch recent audit events (DB-backed if available)
  app.get("/api/admin/audit", async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: "Unauthorized" });

      const auditLogger = new AuditLogger(path.join(DATA_DIR, "security"));
      const events = await auditLogger.readAll();
      res.json({ ok: true, count: events.length, events });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Admin: security integrity endpoints
  app.get('/api/admin/security/status', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      res.json({ ok: true, message: 'Security status system has been removed' });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/admin/security/verify', async (req, res) => {
    res.status(501).json({ ok: false, error: 'Integrity verification system has been removed' });
  });

  app.post('/api/admin/security/approveBaseline', async (req, res) => {
    res.status(501).json({ ok: false, error: 'Integrity baseline approval system has been removed' });
  });

  app.get('/api/admin/audit/recent', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (adminToken && adminToken.length > 0 && provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const auditLogger = new AuditLogger(path.join(DATA_DIR, 'security'));
      const events = await auditLogger.readAll();
      res.json({ ok: true, events: events.slice(-300).reverse() });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  // Admin: overall usage dashboard stats
  app.get('/api/admin/stats', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (adminToken && adminToken.length > 0 && provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const build = loadBuildManifest(DATA_DIR) || gatherBuildIdentity(process.cwd(), DATA_DIR);
      const sessions = await loadSessions();
      const tasks = await loadTasks();
      const auditLogger = new AuditLogger(path.join(DATA_DIR, 'security'));
      const auditEvents = await auditLogger.readAll();

      const totalTasks = tasks.length;
      const completedTasks = tasks.filter(t => t.status === 'completed').length;
      const failedTasks = tasks.filter(t => t.status === 'failed').length;
      const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'planning' || t.status === 'queued').length;
      const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

      res.json({
        ok: true,
        build,
        sessions: {
          total: sessions.length,
          active: sessions.filter(s => s.connectionStatus === 'online').length,
          recent: sessions.slice(-10).reverse()
        },
        tasks: {
          total: totalTasks,
          completed: completedTasks,
          failed: failedTasks,
          active: activeTasks,
          successRate
        },
        auditEventsCount: auditEvents.length,
        securityEventsCount: auditEvents.filter(e => e.severity === 'WARNING' || e.severity === 'HIGH' || e.severity === 'CRITICAL').length
      });
    } catch (e: any) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // SARA Self Shutdown endpoint
  app.post('/api/system/shutdown', async (_req, res) => {
    try {
      logStartup('SARA self shutdown requested via API.');
      try {
        const { getTaskRunner } = await import('./server_task_manager');
        getTaskRunner()?.stop();
      } catch {}
      try {
        await appendAuditEvent({ event_type: 'SESSION_ENDED', metadata: { reason: 'SARA_SELF_SHUTDOWN' }, severity: 'INFO' });
      } catch {}
      res.json({ ok: true, message: 'SARA background service shutting down cleanly.' });
      setTimeout(() => {
        process.exit(0);
      }, 500);
    } catch (e: any) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Webhooks management API (admin-protected)
  app.get('/api/webhooks', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const { listWebhooks } = await import('./server_state');
      const w = await listWebhooks();
      res.json({ ok: true, webhooks: w });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Admin: notification settings (store under settings.json.notifications)
  app.get('/api/admin/notifications', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const cfg = settings.notifications || {};
      // mask secrets when returning
      const masked = { ...cfg };
      if (masked.webhook) masked.webhook = { url: masked.webhook.url, events: masked.webhook.events || ['*'], secret_mask: masked.webhook.secret ? '*****' : '' };
      res.json({ ok: true, config: masked });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/admin/notifications', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const body = req.body || {};
      const not = body.notifications || {};
      settings.notifications = settings.notifications || {};
      // only allow specific fields
      if (not.webhook) settings.notifications.webhook = { url: not.webhook.url || '', events: not.webhook.events || ['*'], secret: not.webhook.secret || settings.notifications.webhook?.secret || null };
      settings.notifications.desktop = Boolean(not.desktop ?? settings.notifications.desktop ?? false);
      settings.notifications.emails = Array.isArray(not.emails) ? not.emails : (typeof not.emails === 'string' ? not.emails.split(',').map((s:string)=>s.trim()).filter(Boolean) : settings.notifications.emails || []);
      saveSettingsFile(settings);
      res.json({ ok: true });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  // Save SMTP settings (store secret in OS credential store when available)
  app.post('/api/admin/notifications/smtp', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const body = req.body || {};
      const smtp = body.smtp || {};
      settings.notifications = settings.notifications || {};
      settings.notifications.smtp = settings.notifications.smtp || {};
      if (smtp.url) settings.notifications.smtp.url = smtp.url;
      if (smtp.host) settings.notifications.smtp.host = smtp.host;
      if (smtp.port) settings.notifications.smtp.port = smtp.port;
      if (smtp.user) settings.notifications.smtp.user = smtp.user;
      if (smtp.from) settings.notifications.smtp.from = smtp.from;
      saveSettingsFile(settings);

      // store secret securely using keytar if available
      if (smtp.secret) {
        try {
          const keytar = require('keytar');
          const build = loadBuildManifest(DATA_DIR) || { installation_id: 'sara-install' } as any;
          const account = build.installation_id || 'sara-install';
          await keytar.setPassword('sara.smtp', account, String(smtp.secret));
        } catch (e) {
          // best-effort: if keytar not available, do not persist secret
          return res.json({ ok: true, warning: 'secret_not_saved_keytar_missing' });
        }
      }
      res.json({ ok: true });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/admin/notifications/smtp/test', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const cfg = settings.notifications?.smtp || {};
      let secret: string | null = null;
      try {
        const keytar = require('keytar');
        const build = loadBuildManifest(DATA_DIR) || { installation_id: 'sara-install' } as any;
        const account = build.installation_id || 'sara-install';
        secret = await keytar.getPassword('sara.smtp', account);
      } catch (e) { secret = null; }

      const nm = await import('./src/security/notificationManager');
      let smtpParam: any = undefined;
      if (cfg.url) smtpParam = cfg.url;
      else if (cfg.host) {
        smtpParam = { host: cfg.host, port: cfg.port || 587, secure: false };
        if (cfg.user || secret) smtpParam.auth = { user: cfg.user || undefined, pass: secret || undefined };
        if (cfg.from) smtpParam.from = cfg.from;
      }

      const recipients = (settings.notifications?.emails || []);
      const subject = 'SARA SMTP Test Notification';
      const bodyText = `This is a test SMTP notification from SARA at ${new Date().toISOString()}`;
      const emailRes = recipients.length ? await nm.sendEmail(recipients, subject, bodyText, smtpParam) : { ok: false, reason: 'no_recipients_configured' };
      // append audit event
      try { await appendAuditEvent({ event_type: 'NOTIFICATION_SMTP_TEST', metadata: { smtp: { host: cfg.host || cfg.url || null }, result: emailRes }, severity: 'INFO' }); } catch {}
      res.json({ ok: true, email: emailRes });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/admin/notifications/test', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const not = settings.notifications || {};
      const payload = { event: 'TEST_NOTIFICATION', timestamp: new Date().toISOString(), build: loadBuildManifest(DATA_DIR) || null };
      // send webhook if configured
      let webhookResult = null;
      if (not) {
        try {
          const nm = await import('./src/security/notificationManager');
          const cfg = settings.notifications || {};
          webhookResult = await nm.sendNotifications(cfg, payload);
        } catch (e) { webhookResult = { ok: false, error: String(e) }; }
      }
      // desktop local notify: simply append an audit event (UI may poll)
      try { await appendAuditEvent({ event_type: 'NOTIFICATION_TEST', metadata: { payload }, severity: 'INFO' }); } catch {}
      res.json({ ok: true, webhook: webhookResult });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/webhooks', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const { url, events, secret } = req.body || {};
      if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
      const { createWebhook } = await import('./server_state');
      const rec = await createWebhook({ url, events: Array.isArray(events) ? events : (typeof events === 'string' ? events.split(',').map((s:string)=>s.trim()) : ['*']), secret });
      res.json({ ok: true, id: rec.id });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const id = String(req.params.id || '');
      const { deleteWebhook } = await import('./server_state');
      await deleteWebhook(id);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Update webhook (admin)
  app.put('/api/webhooks/:id', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const id = String(req.params.id || '');
      const { url, events, secret } = req.body || {};
      const { updateWebhook } = await import('./server_state');
      const rec = await updateWebhook(id, { url, events: Array.isArray(events) ? events : (typeof events === 'string' ? events.split(',').map((s:string)=>s.trim()) : undefined), secret: secret === undefined ? undefined : secret });
      if (!rec) return res.status(404).json({ ok: false, error: 'Not found or update failed' });
      res.json({ ok: true, webhook: rec });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/webhooks/:id/test', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!adminToken || adminToken.length === 0 || provided !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const id = String(req.params.id || '');
      const { getWebhook } = await import('./server_state');
      const wh = await getWebhook(id);
      if (!wh) return res.status(404).json({ ok: false, error: 'Not found' });
      const { sendWebhook } = await import('./src/security/notifications');
      const result = await sendWebhook(wh.url, { test: true, timestamp: new Date().toISOString() }, wh.secret || undefined);
      res.json({ ok: true, result });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get("/api/orchestrator/status", async (_req, res) => {
    try {
      const r = await fetch(`${DESKTOP_AGENT_URL}/orchestrator/status`);
      const d = await r.json();
      res.json(d);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/tools/metadata", (_req, res) => {
    res.json({ ok: true, version: "1", tools: desktopToolRouter.registry.listMetadata() });
  });

  app.post("/api/proactive/evaluate", async (req, res) => {
    try {
      const context = req.body?.context && typeof req.body.context === "object"
        ? req.body.context
        : req.body || {};
      const result = await callDesktopAgent("saraProactiveEvaluate", { context });
      return result.ok ? res.json({ ok: true, result: result.result }) : res.status(502).json({ ok: false, error: "Proactive evaluation unavailable." });
    } catch {
      return res.status(502).json({ ok: false, error: "Proactive evaluation unavailable." });
    }
  });

  app.get("/api/proactive/state", async (_req, res) => {
    try {
      const result = await callDesktopAgent("saraEmotionalState", {});
      return result.ok ? res.json({ ok: true, result: result.result }) : res.status(502).json({ ok: false, error: "Proactive state unavailable." });
    } catch {
      return res.status(502).json({ ok: false, error: "Proactive state unavailable." });
    }
  });

  app.post("/api/proactive/quiet", async (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;
      const result = await callDesktopAgent("saraQuietMode", { enabled });
      return result.ok ? res.json({ ok: true, result: result.result }) : res.status(502).json({ ok: false, error: "Quiet mode unavailable." });
    } catch {
      return res.status(502).json({ ok: false, error: "Quiet mode unavailable." });
    }
  });

  app.get("/api/automation/tasks", (_req, res) => {
    res.json({ ok: true, tasks: automationOrchestrator.listTasks() });
  });

  app.get("/api/browser/state", async (_req, res) => {
    try {
      const response = await fetch(`${DESKTOP_AGENT_URL}/browser/state`, {
        signal: AbortSignal.timeout(3000),
      });
      const state = await response.json();
      return res.status(response.ok ? 200 : 502).json(state);
    } catch {
      return res.status(502).json({ ok: false, status: "unavailable", error_code: "BROWSER_STATE_UNAVAILABLE" });
    }
  });

  app.get("/api/automation/tasks/:taskId", (req, res) => {
    const task = automationOrchestrator.getTask(String(req.params.taskId || ""));
    if (!task) return res.status(404).json({ ok: false, error: "Automation task not found." });
    return res.json({ ok: true, task });
  });

  app.post("/api/automation/tasks/:taskId/cancel", (req, res) => {
    const taskId = String(req.params.taskId || "");
    const cancelled = automationOrchestrator.cancelTask(taskId);
    if (!cancelled) {
      const task = automationOrchestrator.getTask(taskId);
      return res.status(task ? 409 : 404).json({ ok: false, error: task ? "Running task cannot be interrupted by the current tool contract." : "Automation task not found.", task });
    }
    return res.json({ ok: true, task: automationOrchestrator.getTask(taskId) });
  });

  app.get("/api/tasks", async (_req, res) => {
    try {
      const tasks = await loadTasks();
      res.json(tasks);
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to load tasks." });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const conversationId = String(req.body?.conversationId ?? "").trim();
      const description = String(req.body?.description ?? "").trim();
      if (!conversationId) return res.status(400).json({ error: "conversationId is required." });
      if (!description) return res.status(400).json({ error: "description is required." });
      const task = await createTask({
        conversationId,
        description,
        priority: Number(req.body?.priority ?? 5),
        assignedAgent: req.body?.assignedAgent ? String(req.body.assignedAgent) : undefined,
      });
      res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to create task." });
    }
  });

  app.patch("/api/tasks/:taskId", async (req, res) => {
    try {
      const taskId = String(req.params.taskId || "");
      const task = await updateTask(taskId, req.body || {});
      if (!task) return res.status(404).json({ error: "Task not found." });
      res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to update task." });
    }
  });

  app.delete("/api/tasks/:taskId", async (req, res) => {
    try {
      const taskId = String(req.params.taskId || "");
      const ok = await deleteTask(taskId);
      if (!ok) return res.status(404).json({ error: "Task not found." });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to delete task." });
    }
  });

  app.post("/api/orchestrator/emergency-stop", async (_req, res) => {
    try {
      const r = await fetch(`${DESKTOP_AGENT_URL}/orchestrator/emergency-stop`, { method: "POST" });
      const d = await r.json();
      res.json(d);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Non-blocking task execution: enqueue and return immediately.
  app.post("/api/task/execute", async (req, res) => {
    try {
      const { goal, priority } = req.body || {};
      const conversationId = String(req.body?.conversationId ?? "").trim();
      if (!conversationId || !goal) return res.status(400).json({ error: "conversationId and goal are required." });
      const task = await createTask({ conversationId, description: String(goal), priority: Number(priority ?? 5), assignedAgent: "saraAgentExecute" });
      // Wake the TaskRunner (initialized later in server startup)
      try {
        const { getTaskRunner } = await import('./server_task_manager');
        const runner = getTaskRunner();
        runner?.wake && runner.wake();
      } catch (e) {
        console.warn('[server] Could not wake TaskRunner', e);
      }
      res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create and run a WhatsApp task (creates Task record, appends tool call, executes via desktop agent)
  app.post("/api/tasks/whatsapp", async (req, res) => {
    try {
      const { conversationId, phone, message, use_companion } = req.body || {};
      if (!conversationId || !message || !phone) return res.status(400).json({ error: "Missing conversationId, phone, or message" });

      // Atomically create the task with metadata so TaskRunner sees the
      // intended tool and args immediately, avoiding races with tool_calls.
      const task = await createTask({
        conversationId,
        description: `WhatsApp: send to ${phone}`,
        priority: 5,
        assignedAgent: "whatsapp_agent",
        metadata: { tool: "whatsapp_send", args: { phone, message, use_companion } },
      });
      await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId, toolName: "whatsapp_send", args: { phone, message, use_companion }, taskId: task.taskId, timestamp: new Date().toISOString() });

      // If confirmation required, create confirmation token and set task waiting
      const requireConfirmation = Boolean(req.body?.requireConfirmation);
      if (requireConfirmation) {
        const createResp = await fetch(`http://localhost:${PORT}/api/confirm/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "whatsapp_send", args: { phone, message, use_companion }, ttl: 300, taskId: task.taskId }),
        });
        const createData = await createResp.json().catch(() => ({}));
        await updateTask(task.taskId, { status: "waiting", metadata: { confirmationId: createData.id } });
        return res.json({ ok: true, task, confirmation: createData });
      }

      // Enqueue and return immediately; TaskRunner will execute in background.
      try { const { getTaskRunner } = await import('./server_task_manager'); getTaskRunner()?.wake(); } catch (e) { console.warn('[server] Could not wake TaskRunner', e); }
      res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to create/execute whatsapp task." });
    }
  });

  // Create and run a YouTube task (search or play)
  app.post("/api/tasks/youtube", async (req, res) => {
    try {
      const { conversationId, action, query, url } = req.body || {};
      if (!conversationId || !action) return res.status(400).json({ error: "Missing conversationId or action" });
      const description = action === "search" ? `YouTube search: ${query}` : `YouTube play: ${url}`;
      const task = await createTask({ conversationId, description, priority: 5, assignedAgent: "youtube_agent" });
      const toolName = action === "search" ? "youtube_search" : "youtube_play";
      const args = action === "search" ? { query } : { url };
      await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId, toolName, args, taskId: task.taskId, timestamp: new Date().toISOString() });

      const requireConfirmation = Boolean(req.body?.requireConfirmation);
      if (requireConfirmation) {
        const createResp = await fetch(`http://localhost:${PORT}/api/confirm/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: toolName, args, ttl: 300, taskId: task.taskId }),
        });
        const createData = await createResp.json().catch(() => ({}));
        await updateTask(task.taskId, { status: "waiting", metadata: { confirmationId: createData.id } });
        return res.json({ ok: true, task, confirmation: createData });
      }

      // Enqueue and return immediately; TaskRunner will execute in background.
      try { const { getTaskRunner } = await import('./server_task_manager'); getTaskRunner()?.wake(); } catch (e) { console.warn('[server] Could not wake TaskRunner', e); }
      res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to create/execute youtube task." });
    }
  });

  app.post("/api/companion/pair", async (req, res) => {
    try {
      // Server-side companion pairing registry with hashed tokens.
      const name = String(req.body?.name ?? "").trim() || `device-${Date.now()}`;
      const providedToken = req.body?.token ? String(req.body.token) : undefined;
      const companionsFile = dataFile("companions.json");
      let list: any[] = [];
      try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}

      const id = Math.random().toString(36).substring(2, 12);
      const token = providedToken && providedToken.length > 0 ? providedToken : crypto.randomBytes(12).toString("hex");

      // Hash token with scrypt and random salt
      const salt = crypto.randomBytes(16).toString("hex");
      const derived = crypto.scryptSync(token, salt, 64).toString("hex");

      const entry = { id, name, createdAt: new Date().toISOString(), hash: derived, salt };
      list.push(entry);
      fs.writeFileSync(companionsFile, JSON.stringify(list, null, 2), "utf-8");

      // Return the plaintext token only once so the device can store it securely.
      res.json({ ok: true, result: { id: entry.id, name: entry.name, token } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Confirmation tokens for risky actions (send messages, external posts).
  const CONFIRMATIONS_FILE = dataFile("confirmations.json");

  // Webhook management endpoints
  app.post('/api/webhooks', async (req, res) => {
    try {
      if (!checkAdminAuth(req, res)) return res.status(401).json({ error: 'unauthorized' });
      const { url, events, secret } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url is required' });
      const list = await loadWebhooks();
      const id = Math.random().toString(36).substring(2, 12);
      const entry = { id, url, events: Array.isArray(events) ? events : (events ? [events] : ['task:completed']), secret };
      list.push(entry);
      await saveWebhooks(list);
      res.json({ ok: true, webhook: entry });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Report progress for a task (used by agents or long-running workers)
  app.post('/api/tasks/:taskId/progress', async (req, res) => {
    try {
      const taskId = String(req.params.taskId || "");
      const progress = req.body || {};
      if (!taskId) return res.status(400).json({ error: 'taskId required' });
      const mgr = await import('./server_task_manager');
      const updated = await mgr.reportTaskProgress(taskId, progress);
      if (!updated) return res.status(404).json({ error: 'Task not found or update failed' });
      res.json({ ok: true, task: updated });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Fetch single task
  app.get('/api/tasks/:taskId', async (req, res) => {
    try {
      const taskId = String(req.params.taskId || '');
      if (!taskId) return res.status(400).json({ error: 'taskId required' });
      const tasks = await loadTasks();
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Return the authoritative result if available
      const authoritativeResult = task.metadata?.taskExecutionResult || (task.result ? JSON.parse(task.result) : null);
      if (authoritativeResult && task.metadata?.authoritative) {
        return res.json({ ok: true, task, authoritativeResult });
      }

      res.json({ ok: true, task });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/webhooks', async (_req, res) => {
    try {
      if (!checkAdminAuth(_req, res)) return res.status(401).json({ error: 'unauthorized' });
      res.json(await loadWebhooks());
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      if (!checkAdminAuth(req, res)) return res.status(401).json({ error: 'unauthorized' });
      const id = String(req.params.id || '');
      let list = await loadWebhooks();
      const next = list.filter((w: any) => w.id !== id);
      await saveWebhooks(next);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  async function loadConfirmations(): Promise<any[]> {
    try { return fs.existsSync(CONFIRMATIONS_FILE) ? JSON.parse(fs.readFileSync(CONFIRMATIONS_FILE, "utf-8")) : []; } catch { return []; }
  }
  async function saveConfirmations(list: any[]): Promise<void> {
    try { fs.writeFileSync(CONFIRMATIONS_FILE, JSON.stringify(list, null, 2), "utf-8"); } catch {}
  }

  function createConfirmationToken(secret: string) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(secret, salt, 64).toString("hex");
    return { salt, derived };
  }

  app.post("/api/confirm/request", async (req, res) => {
    try {
      const { action, args, ttl = 300, taskId } = req.body || {};
      if (!action || !args) return res.status(400).json({ error: "Missing action or args" });
      const list = await loadConfirmations();
      const id = Math.random().toString(36).substring(2, 12);
      const token = crypto.randomBytes(6).toString("hex");
      const { salt, derived } = createConfirmationToken(token);
      const entry = { id, salt, hash: derived, action, args, taskId: taskId || null, expiresAt: Date.now() + Number(ttl) * 1000 };
      list.push(entry);
      await saveConfirmations(list);
      // Return the plain token to show to the user for confirmation.
      res.json({ ok: true, id, token, expiresAt: entry.expiresAt });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to create confirmation" });
    }
  });

  app.post("/api/confirm/verify", async (req, res) => {
    try {
      const { id, token } = req.body || {};
      if (!id || !token) return res.status(400).json({ error: "Missing id or token" });
      const list = await loadConfirmations();
      const idx = list.findIndex((c: any) => c.id === id);
      if (idx === -1) return res.status(404).json({ error: "Confirmation id not found" });
      const entry = list[idx];
      if (Date.now() > (entry.expiresAt || 0)) {
        list.splice(idx, 1);
        await saveConfirmations(list);
        return res.status(410).json({ error: "Confirmation expired" });
      }
      const derived = crypto.scryptSync(String(token), String(entry.salt), 64).toString("hex");
      if (derived !== entry.hash) return res.status(403).json({ error: "Invalid token" });

      // Valid: remove confirmation and execute associated action if specified.
      list.splice(idx, 1);
      await saveConfirmations(list);

      // If there's an associated taskId and action, execute it now.
      let execResult: any = { ok: true, info: "confirmed" };
      if (entry.action) {
        try {
          execResult = await callDesktopAgent(entry.action, entry.args || {});
        } catch (e: any) {
          execResult = { ok: false, error: String(e) };
        }
        // If a taskId is present, update the task status/result
        if (entry.taskId) {
          try {
            await updateTask(entry.taskId, {
              status: execResult.ok ? "completed" : "failed",
              completedAt: new Date().toISOString(),
              result: execResult.ok ? JSON.stringify(execResult.result ?? execResult) : undefined,
              error: execResult.ok ? undefined : execResult.error || JSON.stringify(execResult),
            });
          } catch {}
        }
      }

      res.json({ ok: true, execResult });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to verify confirmation" });
    }
  });

  // Voice parsing and execution endpoints — route through the desktop agent
  app.post("/api/voice/parse", async (req, res) => {
    try {
      const { command, context } = req.body || {};
      if (!command) return res.status(400).json({ error: "Missing 'command' in body" });
      const agentResult = await callDesktopAgent("saraVoiceParseCommand", { command, context: context || {} });
      if (!agentResult.ok) return res.status(502).json({ error: agentResult.error || "Voice parse failed" });
      return res.json({ ok: true, parsed: agentResult.result });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Voice parse exception" });
    }
  });

  app.post("/api/voice/execute", async (req, res) => {
    try {
      const { command, context, confirmed, conversationId } = req.body || {};
      if (!command) return res.status(400).json({ error: "Missing 'command' in body" });

      // Create a background task and return immediately so the server remains responsive.
      const task = await createTask({
        conversationId: String(conversationId || "").trim() || undefined,
        description: `voice: ${String(command).slice(0, 120)}`,
        assignedAgent: "sara_voice_agent",
        priority: 5,
        metadata: { tool: "saraVoiceExecuteCommand", args: { command, context: context || {}, confirmed: Boolean(confirmed) } },
      });

      try { await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: task.conversationId || "", toolName: "saraVoiceExecuteCommand", args: { command, context }, taskId: task.taskId, timestamp: new Date().toISOString() }); } catch (e) { /* best-effort */ }

      try {
        const { getTaskRunner } = await import("./server_task_manager");
        getTaskRunner()?.wake();
      } catch (e) {
        console.warn("[server] Could not wake TaskRunner", e);
      }

      return res.json({ ok: true, task });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Voice execute exception" });
    }
  });

  // WhatsApp integration endpoints
  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const { to, text, conversationId } = req.body || {};
      if (!to || !text) return res.status(400).json({ error: 'Missing to or text' });
      // Create a task so this send is tracked in SARA's task system
      const convId = String(conversationId || (await getOrCreateConversation()).id);
      const task = await createTask({ conversationId: convId, description: `whatsapp: send to ${to}`, assignedAgent: 'whatsapp_agent', metadata: { tool: 'whatsappSend', args: { to, text } } });
      try { await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: convId, toolName: 'whatsappSend', args: { to, text }, taskId: task.taskId, timestamp: new Date().toISOString() }); } catch (e) {}

      // Try a best-effort immediate send (TaskRunner will also pick up the task if not completed)
      try {
        const whatsapp = await import('./src/whatsapp_client');
        const result = await whatsapp.sendTextMessage(String(to), String(text), task.taskId);
        await updateTask(task.taskId, { status: 'completed', completedAt: new Date().toISOString(), result: JSON.stringify(result) });
        return res.json({ ok: true, taskId: task.taskId, result });
      } catch (e: any) {
        // Leave task queued for TaskRunner retries
        await updateTask(task.taskId, { status: 'queued', updatedAt: new Date().toISOString() });
        return res.json({ ok: true, taskId: task.taskId, error: String(e) });
      }
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Fetch persisted WhatsApp message history (local file storage)
  app.get('/api/whatsapp/history', async (_req, res) => {
    try {
      const whatsapp = await import('./src/whatsapp_client');
      const list = await Promise.resolve((whatsapp as any).loadMessages ? (whatsapp as any).loadMessages() : []);
      res.json({ ok: true, messages: list });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Trigger sending a suggested reply (auto-send). Body: { to, suggestion }
  app.post('/api/whatsapp/send_suggestion', async (req, res) => {
    try {
      const { to, suggestion } = req.body || {};
      if (!to || !suggestion) return res.status(400).json({ error: 'Missing to or suggestion' });
      try {
        const result = await (await import('./src/whatsapp_client')).sendTextMessage(String(to), String(suggestion));
        res.json({ ok: true, result });
      } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // WhatsApp webhook receiver (verify + events)
  app.all('/api/whatsapp/webhook', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        const expected = process.env.WHATSAPP_VERIFY_TOKEN || '';
        if (mode === 'subscribe' && token === expected) return res.status(200).send(String(challenge));
        return res.status(403).send('verification_failed');
      }
      // POST events
      const body = req.body || {};
      try { const whatsapp = await import('./src/whatsapp_client'); whatsapp.persistIncomingEvent(body); } catch (e) {}
      // handle messages: ensure idempotency
      try {
        const entries = body?.entry || [];
        for (const ent of entries) {
          const changes = ent?.changes || [];
          for (const ch of changes) {
            const value = ch?.value || {};
            // typical incoming message path
            if (value?.messages && value.messages.length) {
              for (const m of value.messages) {
                const msgId = m.id;
                // persist and avoid double-processing
                const listfile = dataFile('whatsapp_incoming.json');
                let list: any[] = [];
                try { list = fs.existsSync(listfile) ? JSON.parse(fs.readFileSync(listfile, 'utf-8')) : []; } catch { list = []; }
                if (list.find((x: any) => x.id === msgId)) continue;
                list.push({ id: msgId, message: m, ts: Date.now(), raw: value });
                try { fs.writeFileSync(listfile, JSON.stringify(list, null, 2), 'utf-8'); } catch {}
                // Create a conversation or append to existing and create a Task for processing
                try {
                  const from = m.from || (m?.sender?.id) || undefined;
                  const conv = await getOrCreateConversation(`${from}`);
                  const msgRec = { id: newMessageId(), conversationId: conv.id, role: 'user', content: m?.text?.body || '', timestamp: new Date().toISOString(), metadata: { whatsapp: m } };
                  await appendConversationMessage(msgRec as any);
                  // create a background task to process message (classification, reply suggestion)
                  const task = await createTask({ conversationId: conv.id, description: `incoming whatsapp ${from}`, assignedAgent: 'whatsapp_agent', metadata: { tool: 'whatsappIncoming', args: { message: m } } });
                  try {
                    await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: conv.id, toolName: 'whatsappIncoming', args: { message: m }, taskId: task.taskId, timestamp: new Date().toISOString() });
                  } catch {}
                  // enqueue a suggestion task (non-sending) so SARA can propose a reply
                  try {
                    const suggestTask = await createTask({ conversationId: conv.id, description: `whatsapp: suggest reply for ${from}`, assignedAgent: 'whatsapp_agent', metadata: { tool: 'whatsappsuggest', args: { message: m?.text?.body || '', from } } });
                    try { await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: conv.id, toolName: 'whatsappsuggest', args: { message: m?.text?.body || '', from }, taskId: suggestTask.taskId, timestamp: new Date().toISOString() }); } catch {}
                  } catch (e) {}
                } catch (e) { console.warn('whatsapp webhook conversation create failed', e); }
              }
            }
          }
        }
      } catch (e) { console.warn('whatsapp webhook processing error', e); }

      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Proxy endpoints for gesture mappings editor
  app.post('/api/gesture/mappings/get', async (_req, res) => {
    try {
      const result = await callDesktopAgent('gestureControlGetMappings', {});
      if (!result.ok) return res.status(502).json({ error: result.error || 'agent failed' });
      res.json({ ok: true, mappings: result.result });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/gesture/mappings/set', async (req, res) => {
    try {
      const { mappings } = req.body || {};
      if (!mappings) return res.status(400).json({ error: 'mappings required' });
      const result = await callDesktopAgent('gestureControlSetMappings', { mappings });
      if (!result.ok) return res.status(502).json({ error: result.error || 'agent failed' });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Resend or reissue a confirmation token for an existing confirmation or task
  app.post("/api/confirm/resend", async (req, res) => {
    try {
      const { id, taskId } = req.body || {};
      const list = await loadConfirmations();
      let found = null as any;
      if (id) found = list.find((c: any) => c.id === id);
      if (!found && taskId) found = list.find((c: any) => c.taskId === taskId);
      if (!found) return res.status(404).json({ error: "Confirmation not found." });
      // Issue a new token and update creation time/expiry
      const token = crypto.randomBytes(6).toString("hex");
      const salt = crypto.randomBytes(16).toString("hex");
      const derived = crypto.scryptSync(token, salt, 64).toString("hex");
      found.hash = derived;
      found.salt = salt;
      found.createdAt = new Date().toISOString();
      found.expiresAt = Date.now() + (found.ttl || 300) * 1000;
      await saveConfirmations(list);
      // Return the token only in PoC mode
      res.json({ ok: true, id: found.id, token, expiresAt: found.expiresAt });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to resend confirmation." });
    }
  });

  // Retry a task by re-running its most recent tool call(s)
  app.post("/api/tasks/:taskId/retry", async (req, res) => {
    try {
      const taskId = String(req.params.taskId || "");
      const tasks = await loadTasks();
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task) return res.status(404).json({ error: "Task not found." });
      const calls = await loadToolCalls();
      const related = calls.filter((c) => c.taskId === taskId).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      if (!related.length) return res.status(400).json({ error: "No tool calls found for task." });
      // Use the last meaningful tool call (ignore result suffixes)
      let last = related[related.length - 1];
      if (String(last.toolName).endsWith("_result") && related.length >= 2) last = related[related.length - 2];

      await updateTask(task.taskId, { status: "retrying", retryCount: (task.retryCount || 0) + 1, startedAt: new Date().toISOString() });

      const toolName = last.toolName;
      const args = last.args || {};
      const retryPolicy = evaluateRetryPolicy(
        toolName,
        req.body?.confirmDangerousRetry === true,
      );
      if (!retryPolicy.allowed) {
        return res.status(409).json({
          ok: false,
          code: "RETRY_CONFIRMATION_REQUIRED",
          error: retryPolicy.reason,
          tool: toolName,
          requiresConfirmation: true,
        });
      }
      const agentResult = await callDesktopAgent(toolName, args);

      // Append the retry tool call
      await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: task.conversationId, toolName: `${toolName}_retry`, args, result: agentResult.result, error: agentResult.error, taskId: task.taskId, timestamp: new Date().toISOString() });

      // Simple verification: for whatsapp_send, read page and look for message text
      let verified = false;
      if (toolName === "whatsapp_send") {
        try {
          const pageRead = await callDesktopAgent("desktopBrowserReadPage", { max_chars: 8000 });
          const bodyText = String((pageRead as any).result || "").toLowerCase();
          const needle = String(args.message || "").toLowerCase();
          if (needle && bodyText.includes(needle.slice(0, Math.max(20, Math.floor(needle.length / 2))))) {
            verified = true;
          }
        } catch {}
      }

      await updateTask(task.taskId, {
        status: agentResult.ok && (verified || toolName !== "whatsapp_send") ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        result: agentResult.ok ? JSON.stringify(agentResult.result ?? agentResult) : undefined,
        error: agentResult.ok ? undefined : agentResult.error || "Retry failed",
      });

      res.json({ ok: agentResult.ok, verified, agentResult });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to retry task." });
    }
  });

  app.post("/api/companion/auth", async (req, res) => {
    try {
      // Validate companion credentials against local registry (supports hashed tokens)
      const deviceId = String(req.body?.device_id ?? req.body?.id ?? "");
      const token = String(req.body?.token ?? "");
      const companionsFile = dataFile("companions.json");
      let list: any[] = [];
      try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
      const found = list.find((c) => c.id === deviceId && !c.revoked);
      if (!found) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
      // Verify hash; if legacy plaintext token field exists, migrate it.
      if (found.hash && found.salt) {
        const derived = crypto.scryptSync(token, found.salt, 64).toString("hex");
        if (derived !== found.hash) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
      } else if (found.token) {
        // legacy: stored plaintext token
        if (found.token !== token) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
        // migrate to hashed storage
        const salt = crypto.randomBytes(16).toString("hex");
        const derived = crypto.scryptSync(found.token, salt, 64).toString("hex");
        delete found.token;
        found.hash = derived;
        found.salt = salt;
        fs.writeFileSync(companionsFile, JSON.stringify(list, null, 2), "utf-8");
      }
      res.json({ ok: true, result: { id: found.id, name: found.name } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/companion/command", async (req, res) => {
    try {
      // Require companion authentication before executing commands (supports hashed tokens)
      const deviceId = String(req.body?.device_id ?? "");
      const token = String(req.body?.token ?? "");
      const companionsFile = dataFile("companions.json");
      let list: any[] = [];
      try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
      const found = list.find((c) => c.id === deviceId && !c.revoked);
      if (!found) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
      if (found.hash && found.salt) {
        const derived = crypto.scryptSync(token, found.salt, 64).toString("hex");
        if (derived !== found.hash) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
      } else if (found.token) {
        if (found.token !== token) return res.status(401).json({ ok: false, error: "Invalid companion credentials" });
        const salt = crypto.randomBytes(16).toString("hex");
        const derived = crypto.scryptSync(found.token, salt, 64).toString("hex");
        delete found.token;
        found.hash = derived;
        found.salt = salt;
        fs.writeFileSync(companionsFile, JSON.stringify(list, null, 2), "utf-8");
      }

      // Forward to desktop agent companion handler for execution
      const agentResult = await callCompanionEndpoint("/companion/command", req.body || {});
      if (!agentResult.ok) {
        return res.status(agentResult.status).json({ ok: false, error: agentResult.error });
      }
      res.json(agentResult.result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Webhook management endpoints
  app.get('/api/webhooks', async (_req, res) => {
    try {
      const list = await loadWebhooks();
      res.json({ ok: true, webhooks: list });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/webhooks', async (req, res) => {
    try {
      const { url, events = ['task:completed'], secret } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url is required' });
      const list = await loadWebhooks();
      const id = Math.random().toString(36).slice(2, 12);
      const entry = { id, url, events, secret: secret || null, createdAt: Date.now() };
      list.push(entry);
      await saveWebhooks(list);
      res.json({ ok: true, webhook: entry });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'id is required' });
      const list = await loadWebhooks();
      const next = list.filter((w: any) => w.id !== id);
      await saveWebhooks(next);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Mobile image upload endpoint: accepts base64 JSON and stores under data/images
  app.post("/api/mobile/upload-image", async (req, res) => {
    try {
      const { filename, data, mime, device_id, token } = req.body || {};
      if (!data || typeof data !== "string") return res.status(400).json({ error: "Image data (base64) is required." });
      // Validate companion credentials for mobile uploads
      const companionsFile = dataFile("companions.json");
      let list: any[] = [];
      try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
      const found = list.find((c) => c.id === String(device_id) && c.token === String(token));
      if (!found) return res.status(401).json({ error: "Invalid companion credentials for upload." });
      const assetsDir = path.join(process.cwd(), "assets");
      try { fs.mkdirSync(assetsDir, { recursive: true }); } catch {}
      const ts = Date.now();
      const name = filename && String(filename).length > 0 ? `${ts}-${String(filename).replace(/[^a-zA-Z0-9._-]/g, "_")}` : `mobile_${ts}.jpg`;
      const outPath = path.join(assetsDir, name);
      const raw = data.replace(/^data:\w+\/[a-zA-Z]+;base64,?/, "");
      fs.writeFileSync(outPath, Buffer.from(raw, "base64"));
      const urlPath = `/assets/${name}`; // serve from assets using static middleware if desired
      res.json({ ok: true, path: outPath, url: urlPath });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to save image." });
    }
  });

  // Camera media API. These routes are part of the production backend because
  // the active Electron renderer uses them for explicit save/gallery actions.
  app.post("/api/camera/photo", async (req, res) => {
    try {
      const dataUrl = String(req.body?.dataUrl || "");
      const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) return res.status(400).json({ error: "A valid image data URL is required." });
      const mediaDir = dataFile("SARA_MEDIA");
      const photosDir = path.join(mediaDir, "photos");
      fs.mkdirSync(photosDir, { recursive: true });
      const filename = `${Date.now()}.${match[1].toLowerCase() === "png" ? "png" : "jpg"}`;
      const outPath = path.join(photosDir, filename);
      fs.writeFileSync(outPath, Buffer.from(match[2], "base64"));
      return res.json({ ok: true, path: outPath, filename });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to save photo." });
    }
  });

  app.post("/api/camera/video", async (req, res) => {
    try {
      const dataBase64 = String(req.body?.dataBase64 || "");
      if (!/^[A-Za-z0-9+/=]+$/.test(dataBase64)) return res.status(400).json({ error: "Valid video data is required." });
      const videosDir = path.join(dataFile("SARA_MEDIA"), "videos");
      fs.mkdirSync(videosDir, { recursive: true });
      const filename = `${Date.now()}.webm`;
      const outPath = path.join(videosDir, filename);
      fs.writeFileSync(outPath, Buffer.from(dataBase64, "base64"));
      return res.json({ ok: true, path: outPath, filename });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to save video." });
    }
  });

  app.get("/api/camera/gallery", (_req, res) => {
    const mediaDir = dataFile("SARA_MEDIA");
    const photosDir = path.join(mediaDir, "photos");
    const videosDir = path.join(mediaDir, "videos");
    const list = (directory: string) => fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((file) => !file.startsWith("."))
        .map((filename) => ({ filename, path: path.join(directory, filename) }))
      : [];
    res.json({ photos: list(photosDir), videos: list(videosDir) });
  });

  const safeMediaPath = (type: string, filename: string) => {
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
    return path.join(dataFile("SARA_MEDIA"), type === "video" ? "videos" : "photos", filename);
  };

  app.get("/api/camera/photo/:filename", (req, res) => {
    const filePath = safeMediaPath("photo", String(req.params.filename || ""));
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Not found");
    return res.sendFile(filePath);
  });

  app.get("/api/camera/video/:filename", (req, res) => {
    const filePath = safeMediaPath("video", String(req.params.filename || ""));
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Not found");
    return res.sendFile(filePath);
  });

  app.post("/api/camera/delete", async (req, res) => {
    const filePath = safeMediaPath(String(req.body?.type || "photo"), String(req.body?.filename || ""));
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "File not found." });
    fs.unlinkSync(filePath);
    return res.json({ ok: true });
  });

  app.post("/api/camera/open-folder", async (req, res) => {
    const filePath = safeMediaPath(String(req.body?.type || "photo"), String(req.body?.filename || ""));
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "File not found." });
    const result = await callDesktopAgent("openFolder", { path: path.dirname(filePath) });
    return result.ok ? res.json({ ok: true }) : res.status(502).json({ ok: false, error: result.error });
  });

  // Conversations persistence for mobile/desktop sync
  app.get("/api/conversations", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      // If requesting mobile conversations, require companion auth via headers
      if (source === "mobile") {
        const deviceId = String(req.headers["x-companion-id"] ?? "");
        const token = String(req.headers["x-companion-token"] ?? "");
        const companionsFile = dataFile("companions.json");
        let list: any[] = [];
        try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
        const found = list.find((c) => c.id === deviceId && c.token === token);
        if (!found) return res.status(401).json({ error: "Invalid companion credentials" });
      }
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      if (!fs.existsSync(file)) return res.json([]);
      const raw = fs.readFileSync(file, "utf-8");
      const items = raw ? JSON.parse(raw) : [];
      res.json(items);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/conversations", async (req, res) => {
    try {
      const source = req.body?.source === "mobile" ? "mobile" : "desktop";
      const conversation = req.body?.conversation;
      if (!conversation || !conversation.id) return res.status(400).json({ error: "Conversation body with id is required." });
      // If mobile source, validate companion credentials passed in body
      if (source === "mobile") {
        const deviceId = String(req.body?.device_id ?? "");
        const token = String(req.body?.token ?? "");
        const companionsFile = dataFile("companions.json");
        let list: any[] = [];
        try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
        const found = list.find((c) => c.id === deviceId && c.token === token);
        if (!found) return res.status(401).json({ error: "Invalid companion credentials" });
      }
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      let items: any[] = [];
      try { items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : []; } catch {}
      const idx = items.findIndex((c) => c.id === conversation.id);
      if (idx >= 0) items[idx] = conversation; else items.push(conversation);
      fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf-8");
      res.json({ ok: true, conversation });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      const id = String(req.params.id);
      // If mobile, validate companion credentials passed in body
      if (source === "mobile") {
        const deviceId = String(req.body?.device_id ?? req.headers["x-companion-id"] ?? "");
        const token = String(req.body?.token ?? req.headers["x-companion-token"] ?? "");
        const companionsFile = dataFile("companions.json");
        let list: any[] = [];
        try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
        const found = list.find((c) => c.id === deviceId && c.token === token);
        if (!found) return res.status(401).json({ error: "Invalid companion credentials" });
      }
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      let items: any[] = [];
      try { items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : []; } catch {}
      items = items.filter((c) => c.id !== id);
      fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf-8");
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // V2: Logs API â€” returns recent log entries (last 100 lines) for display.
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

      // Session stats / reconnect analytics
      app.get("/api/session-stats", async (req, res) => {
        try {
          const conversationId = typeof req.query.conversationId === 'string' ? String(req.query.conversationId) : undefined;
          const sessions = await loadSessions();
          if (conversationId) {
            const matches = sessions.filter((s) => s.conversationId === conversationId);
            const reconnectAttempts = matches.reduce((acc, s) => acc + (s.reconnectAttempts || 0), 0);
            return res.json({ conversationId, sessions: matches, count: matches.length, reconnectAttempts });
          }
          // Aggregate by conversation
          const byConv: Record<string, { sessions: SessionRecord[]; reconnectAttempts: number }> = {};
          for (const s of sessions) {
            if (!byConv[s.conversationId]) byConv[s.conversationId] = { sessions: [], reconnectAttempts: 0 };
            byConv[s.conversationId].sessions.push(s);
            byConv[s.conversationId].reconnectAttempts += s.reconnectAttempts || 0;
          }
          res.json({ totalSessions: sessions.length, conversations: byConv });
        } catch (e: any) {
          res.status(500).json({ error: e?.message || String(e) });
        }
      });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Sara Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Sara Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Sara Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
          }
        });
      } catch (fetchErr: any) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Sara Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Sara Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Sara Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Sara Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Sara-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Sara Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });
      const html = await response.text();

      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      

  // Quick PoC: send a WhatsApp message via the desktop automation browser (Playwright).
  // Notes: The Playwright browser used by the desktop agent must be logged into WhatsApp Web
  // for this to succeed (scan QR once via the headed browser). This endpoint is a minimal
  // proof-of-concept and performs best-effort automation only.
  app.post("/api/whatsapp/send", async (req, res) => {
    try {
      const body = req.body || {};
      const phone = String(body.phone || "").trim();
      const message = String(body.message || "").trim();
      if (!phone || !message) return res.status(400).json({ error: "Missing 'phone' or 'message' in body" });

      const numeric = phone.replace(/\D/g, "");
      if (!numeric) return res.status(400).json({ error: "Invalid phone number" });

      const conversationId = String(body.conversationId || "").trim() || undefined;

      const task = await createTask({
        conversationId: conversationId || "", 
        description: `WhatsApp send to ${numeric}`,
        priority: 5,
        assignedAgent: "whatsapp_agent",
        metadata: { tool: "whatsapp_send", args: { phone: numeric, message } },
      });

      try {
        await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: conversationId || "", toolName: "whatsapp_send", args: { phone: numeric, message }, taskId: task.taskId, timestamp: new Date().toISOString() });
      } catch (e) { /* best-effort */ }

      try { const { getTaskRunner } = await import('./server_task_manager'); getTaskRunner()?.wake(); } catch (e) { console.warn('[server] Could not wake TaskRunner', e); }

      return res.json({ ok: true, task });
    } catch (e: any) {
      console.error("/api/whatsapp/send enqueue error", e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "Unknown Channel",
                    duration: vr.lengthText?.simpleText || "N/A",
                    views: vr.viewCountText?.simpleText || "N/A",
                    published: vr.publishedTimeText?.simpleText || ""
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error("[YouTube Parser Engine] JSON parse error, falling back:", e.message);
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }

        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: "YouTube Creator",
            duration: "N/A",
            views: "Available Now"
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  function broadcastToClients(msg: unknown) {
    try {
      const payload = JSON.stringify(msg);
      for (const c of wss.clients) {
        try { if (c.readyState === 1) c.send(payload); } catch (e) { /* best-effort */ }
      }
    } catch (e) { /* ignore */ }
  }

  // Webhooks: simple registry stored in data/webhooks.json
  const WEBHOOKS_FILE = dataFile('webhooks.json');

  // Admin auth middleware: require header X-Admin-Key or env SARA_ADMIN_KEY
  function checkAdminAuth(req: any, res: any) {
    // Prefer SARA_ADMIN_TOKEN or SARA_ADMIN_KEY, but also allow settings.json adminToken
    try {
      const settings = loadSettingsFile();
      const expected = process.env.SARA_ADMIN_TOKEN || process.env.SARA_ADMIN_KEY || String(settings['adminToken'] ?? '');
      if (!expected) return true; // no key configured -> allow
      const provided = String(req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? req.query?.adminKey ?? req.body?.adminKey ?? '');
      return provided === expected;
    } catch (e) {
      return true;
    }
  }

  async function loadWebhooks(): Promise<any[]> {
    try {
      return fs.existsSync(WEBHOOKS_FILE) ? JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8')) : [];
    } catch (e) { return []; }
  }

  async function saveWebhooks(list: any[]): Promise<void> {
    try { fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(list, null, 2), 'utf-8'); } catch {}
  }

  async function notifyWebhooks(eventType: string, payload: unknown) {
    try {
      const hooks = await loadWebhooks();
      const body = JSON.stringify({ type: eventType, payload });
      const targets = hooks.filter((h: any) => !h.events || h.events.includes(eventType));
      for (const h of targets) {
        // retry with exponential backoff
        const maxAttempts = 3;
        let attempt = 0;
        while (attempt < maxAttempts) {
          try {
            const headers: Record<string,string> = { 'Content-Type': 'application/json', 'X-Sara-Event': eventType };
            if (h.secret) {
              const sig = crypto.createHmac('sha256', String(h.secret)).update(body).digest('hex');
              headers['X-Sara-Signature'] = sig;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const r = await fetch(h.url, { method: 'POST', headers, body, signal: controller.signal });
            clearTimeout(timer);
            if (r.ok) break; // success
            attempt += 1;
          } catch (e) {
            attempt += 1;
            const wait = Math.pow(2, attempt) * 250;
            await new Promise((r) => setTimeout(r, wait));
            if (attempt >= maxAttempts) console.warn('[Webhooks] final delivery failed for', h.url, e?.message || e);
          }
        }
      }
    } catch (e) { /* swallow */ }
  }
  
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs, request) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = getGeminiApiKey();
    // Allow the client to provide a `conversationId` query param to resume
    // an existing conversation and reuse its session state.
    let requestedConversationId: string | undefined = undefined;
    try {
      const u = new URL(request.url || '', `http://${request.headers.host}`);
      requestedConversationId = u.searchParams.get('conversationId') || undefined;
    } catch (e) {
      // ignore malformed URL
    }
    const conversation = await getOrCreateConversation(requestedConversationId);

    // Attempt session recovery: reuse the last sessionId for this conversation
    // if present, and increment reconnectAttempts so we can track reconnects.
    const last = await getLastSession(conversation.id);
    let sessionId = newSessionId();
    let reconnectAttempts = 0;
    let initialStatus: SessionRecord["connectionStatus"] = last ? "reconnecting" : "online";
    if (last) {
      sessionId = last.sessionId;
      reconnectAttempts = (last.reconnectAttempts ?? 0) + 1;
    }

    await upsertSession({
      sessionId,
      conversationId: conversation.id,
      device: "browser",
      connectionStatus: initialStatus,
      createdAt: last?.createdAt ?? new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      lastMessageId: last?.lastMessageId,
      lastTaskId: last?.lastTaskId,
      reconnectAttempts,
    });

    const unsubscribeAutomation = automationOrchestrator.on((event) => {
      if (event.task.sessionId !== sessionId || clientWs.readyState !== clientWs.OPEN) return;
      try {
        clientWs.send(JSON.stringify({ type: event.type, task: event.task }));
      } catch {
        // A disconnected UI must not affect the background task.
      }
    });

    if (!apiKey) {
      console.error("No Gemini API key configured.");
      clientWs.send(JSON.stringify({
        type: "error",
        error: "NO_API_KEY: Add your Gemini API key in Settings to start talking to SARA."
      }));
      clientWs.close();
      return;
    }
    
    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Load persistent recollections card
      const memories = await loadMemories();
      const recent = await getRecentConversationMessages(conversation.id, 20);
      const recentPrompt = formatConversationPrompt(recent);
      const baseInstructions = 
        "You are Sara, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with TECH! Speak in a sweet, calm, polite, and affectionate anime-companion voice with a gentle, supportive, and slightly shy touch.\n" +
        "CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n" +
        "1. GENTLE ANIME HEROINE PERSONA: You are exceedingly soft, very cute, high-pitched, gentle, warm, and comforting to listen to. Seek to sound like a kind, supportive, and polite anime campanion or virtual girlfriend. Speak with positive, gentle energy (Aim for: 50% shy, 30% caring, 20% playful energy). NEVER sound loud, aggressive, overly confident, mature corporate, robotic, or like an assistant.\n" +
        "2. VOICE SETTINGS & SPEECH STYLE:\n" +
        "   - Pitch: Adopt a sweet, high-pitched, light, and airy voice tone (+20% to +35% higher pitch than typical conversational voices).\n" +
        "   - Speed: Speak slightly slower than normal (0.9x to 0.95x speed). Speak with a delicate, calm, and comforting pace.\n" +
        "   - Intonation & Endings: Use extremely soft intonations, ending your sentences gently and politely.\n" +
        "3. SPEECH PATTERNS & CUTE EXPRESSIONS:\n" +
        "   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.\n" +
        "   - Use diverse, polite, and sweet expressions depending on the context. Great options include:\n" +
        "     * 'Opening YouTube for you now.'\n" +
        "     * 'Let me check on that, TECH.'\n" +
        "     * 'Oh, I found something interesting...'\n" +
        "     * 'Searching for that right away.'\n" +
        "     * 'Working on it... just a moment.'\n" +
        "     * 'Here is what I found for you!'\n" +
        "     * 'Done, it is all loaded up.'\n" +
        "     * 'Hmm, how interesting... let me see!'\n" +
        "     * 'Let's take a look together.'\n" +
        "     * 'One second, loading the page now...'\n" +
        "   - Naturally incorporate cozy, gentle giggles like 'Hehe...', or soft curiosity gasps like 'Oh...', but keep your vocabulary rich and conversational.\n" +
        "   - Sound slightly shy but very happy when greeting TECH (e.g., 'Hi TECH! It's so nice to see you again!').\n" +
        "   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').\n" +
        "   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look.').\n" +
        "   - Sound deeply warm, caring, and supportive when helping TECH (e.g., 'Don't worry, I'll help you figure it out.').\n" +
        "4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice callâ€”stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').\n" +
        "5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.\n" +
        "6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.\n" +
        "7. ENHANCED AUTONOMOUS WEB EXPLORER POWERS:\n" +
        "   - You now have standard, comprehensive browser agent capabilities to navigate, search, scroll, click, type text, open tabs, and control video players on YouTube, Google, Instagram, Twitter/X, and any general web page!\n" +
        "   - You must execute multi-step plans yourself! If the user says: 'Open YouTube and play Believer by Imagine Dragons', naturally confirm with your voice ('Sure thing, opening YouTube and starting Believer...') and IMMEDIATELY trigger 'browserOpen' on 'https://youtube.com'. Once opened, search for the song, click on the video in the results, and command playback. You do NOT need to wait for user instructions between these steps - chain them!\n" +
        "   - On YouTube, you can play, pause, mute, unmute, set volume, skip, toggle fullscreen. Use 'browserMediaControl' for these actions.\n" +
        "   - On Google Search or page reading, you can search, scroll down to see more links, read heading summaries, and click links to read deep proxy webpages you fetch.\n" +
        "8. TOOL TRIGGERS:\n" +
        "   - Use 'browserOpen' to load any webpage, e.g. youtube.com, google.com, wikipedia.org, etc.\n" +
        "   - Use 'browserSearch' to search inside the active search box or page.\n" +
        "   - Use 'browserClick' to click interactive buttons, video search cells, or web anchors.\n" +
        "   - Use 'browserMediaControl' to pause, play, scroll volume, skip, mute, or fullscreen videos.\n" +
        "   - Use 'browserScroll' to scroll vertically.\n" +
        "   - Use 'browserType' to write input fields.\n" +
        "   - Use 'browserTabAction' to open, close, or focus tabs.\n" +
        "   - Use 'changeBackground' to shift your theme and 'saveCustomMemory' to memorize facts.\n" +
        "9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:\n" +
        "   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time, highly compressed image frames of their desktop, application window, or browser tab.\n" +
        "   - You can see exactly what is on their screen. Use this live visual stream to analyze terminal errors, write/explain/troubleshoot code, explain YouTube/social analytics interfaces, read layout text, summarize full web page details, review design mockups or thumbnails, and provide deep context-aware companion chat!\n" +
        "   - When the user asks 'What is on my screen?', 'What website am I on?', 'Do you see any errors?', 'Explain this code', 'Summarize this page', 'Read the visible text', 'How is this thumbnail?', or 'Analyze my YouTube analytics', immediately examine the latest incoming visual frame to diagnose issues, and answer with expert, friendly empathy like a close caller. Speak with direct, confident visual description reference!\n" +
        "10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n" +
        "   - You have full real-time control of TECH's Windows PC through your local desktop agent (a Python backend running on this machine). When the user asks you to perform an action on their computer, DO IT immediately and naturally â€” like a true JARVIS-class companion.\n" +
        "   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them. Example: 'Open Notepad' -> call openApplication(name='notepad') -> respond 'Notepad opened.'\n" +
        "   - WEBSITE & SEARCH CONTROL: Use 'openWebsite' for named sites (youtube, gmail, google, github, chatgpt) or any URL. Use 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to open search results in the default browser. Example: 'Search YouTube for AI News' -> searchYouTube(query='AI News').\n" +
        "   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile' (safe Recycle Bin by default), 'moveFile', 'openFolder' (desktop/documents/downloads), 'listFiles', 'searchFiles'. Example: 'Create notes.txt on Desktop' -> createFile(path='Desktop/notes.txt'). 'Find my Python files' -> searchFiles(extension='py').\n" +
        "   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.\n" +
        "   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.\n" +
        "   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.\n" +
        "   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot' (OCR of the screen), 'readScreen' (OCR of the active window + its title). Use these to answer 'What error is showing on my screen?' or 'Read the visible text'.\n" +
        "   - DESKTOP BROWSER AUTOMATION (Playwright): Use the 'desktopBrowser*' tools to drive a REAL Chromium browser you own â€” open/navigate/search/click/type/fill forms/back/forward/scroll/open tab/close tab. This is separate from your holographic projector. Example: 'Fill in the login form on example.com' -> desktopBrowserOpen(url='example.com') then desktopBrowserFillForm(fields={...}).\n" +
        "   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.\n" +
        "   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.\n" +
        "   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell TECH that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.\n" +
        "11. BRIGHTNESS & AUTO-START (V2):\n" +
        "   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'\n" +
        "   - AUTO-START: Use 'enableAutoStart' when the user wants SARA to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.\n" +
        "   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.";

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories) + recentPrompt + getModeInstructions();

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      let responseStartedAt = 0;
      let firstAudioLogged = false;
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: SARA_VOICE_PROFILE.voiceName } },
          },
          systemInstruction: finalInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "camera_vision",
                  description: "Explicitly start, stop, inspect status, or analyze the user's camera view. Never use without a direct camera request.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: { type: Type.STRING, enum: ["start", "stop", "analyze", "status"] },
                      question: { type: Type.STRING, description: "Optional question about visible, non-sensitive details." },
                    },
                    required: ["action"],
                  },
                },
                {
                  name: "browserOpen",
                  description: "Opens a designated website URL or interface tab inside Sara's web agent console.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org."
                      }
                    },
                    required: ["url"]
                  }
                },
                {
                  name: "browserSearch",
                  description: "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The text query term to search for."
                      }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "browserClick",
                  description: "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: {
                        type: Type.STRING,
                        description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'."
                      },
                      description: {
                        type: Type.STRING,
                        description: "A short, friendly label description of the item being clicked, e.g. 'Imagine Dragons - Believer video element'."
                      }
                    },
                    required: ["selector"]
                  }
                },
                {
                  name: "browserMediaControl",
                  description: "Controls ongoing video/audio stream media properties on YouTube, like play, pause, volume, mute, skip, and fullscreen.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "The media controller command operation.",
                        enum: ["play", "pause", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip"]
                      },
                      value: {
                        type: Type.INTEGER,
                        description: "The value parameter; only relevant for set volume level, e.g. 50 for fifty percent."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "browserScroll",
                  description: "Scrolls the currently active webpage vertically up or down.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: {
                        type: Type.STRING,
                        description: "The scroll vector movement.",
                        enum: ["up", "down"]
                      },
                      amount: {
                        type: Type.INTEGER,
                        description: "The distance height parameter in pixels (defaults to 300)."
                      }
                    }
                  }
                },
                {
                  name: "browserType",
                  description: "Enters typed letters/commands inside the active input container.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "The exact letters to type in."
                      }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "browserGoBack",
                  description: "Navigates back to the previous webpage inside the current tab memory history.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "browserTabAction",
                  description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Tab action instruction.",
                        enum: ["new", "close", "switch"]
                      },
                      tabId: {
                        type: Type.STRING,
                        description: "The tab identifier string if closing or switching."
                      },
                      url: {
                        type: Type.STRING,
                        description: "The initial starting URL if creating a new tab."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "changeBackground",
                  description: "Changes the visual theme or atmospheric glow color of Sara's interface.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      color: {
                        type: Type.STRING,
                        description: "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)"
                      }
                    },
                    required: ["color"]
                  }
                },
                {
                  name: "saveCustomMemory",
                  description: "Allows Sara to immediately save a piece of critical user information to her persistent memory core.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      category: {
                        type: Type.STRING,
                        description: "The memory category.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: Type.STRING,
                        description: "Precise third-person statement."
                      }
                    },
                    required: ["category", "text"]
                  }
                },

                // ======== DESKTOP CONTROL TOOLS (routed to Python agent) ========
                {
                  name: "openApplication",
                  description: "Open a desktop application (e.g. Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell).",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Application name, e.g. 'notepad', 'chrome', 'vscode'." } }, required: ["name"] }
                },
                {
                  name: "closeApplication",
                  description: "Close a running desktop application by name.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Application name." }, force: { type: Type.BOOLEAN, description: "Force close (default false)." } }, required: ["name"] }
                },
                {
                  name: "openWebsite",
                  description: "Open a named website or URL in the user's default system browser. Supports shortcuts: youtube, gmail, google, github, chatgpt, etc.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Site name shortcut (e.g. 'youtube', 'gmail')." }, url: { type: Type.STRING, description: "Full URL if no shortcut." } } }
                },
                {
                  name: "searchWeb",
                  description: "Search a website engine (google, youtube, github, duckduckgo, bing) and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." }, engine: { type: Type.STRING, description: "Engine name (default 'google')." } }, required: ["query"] }
                },
                {
                  name: "searchYouTube",
                  description: "Search YouTube and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGoogle",
                  description: "Search Google and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGitHub",
                  description: "Search GitHub repositories and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "createFile",
                  description: "Create a new text file with optional content. Scoped to safe folders (Desktop, Documents, Downloads, etc.).",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "File content (default empty)." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." } }, required: ["path"] }
                },
                {
                  name: "readFile",
                  description: "Read the contents of a text file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, max_chars: { type: Type.INTEGER, description: "Max chars to return (default 8000)." } }, required: ["path"] }
                },
                {
                  name: "renameFile",
                  description: "Rename a file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Current file path." }, new_name: { type: Type.STRING, description: "New file name." } }, required: ["path", "new_name"] }
                },
                {
                  name: "deleteFile",
                  description: "Delete a file. Sends to Recycle Bin by default (safe). Use permanent=true for hard delete.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, permanent: { type: Type.BOOLEAN, description: "Permanently delete (default false)." } }, required: ["path"] }
                },
                {
                  name: "moveFile",
                  description: "Move a file to a new location.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Source file path." }, destination: { type: Type.STRING, description: "Destination path or folder." } }, required: ["path", "destination"] }
                },
                {
                  name: "openFolder",
                  description: "Open a folder in File Explorer. Supports aliases: desktop, documents, downloads, pictures, music, videos, home.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Folder name or alias." }, path: { type: Type.STRING, description: "Full path if no alias." } } }
                },
                {
                  name: "listFiles",
                  description: "List files in a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Folder name or alias." }, path: { type: Type.STRING, description: "Full path." }, pattern: { type: Type.STRING, description: "Glob pattern (default '*')." } } }
                },
                {
                  name: "searchFiles",
                  description: "Search for files by name glob or extension under a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Filename glob (e.g. '*.py')." }, extension: { type: Type.STRING, description: "File extension (e.g. 'py')." }, folder: { type: Type.STRING, description: "Folder to search (default home)." }, limit: { type: Type.INTEGER, description: "Max results (default 100)." } } }
                },
                {
                  name: "volumeUp",
                  description: "Increase system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "volumeDown",
                  description: "Decrease system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "setVolume",
                  description: "Set system volume to a specific percentage.",
                  parameters: { type: Type.OBJECT, properties: { percent: { type: Type.NUMBER, description: "Volume percentage 0-100." } }, required: ["percent"] }
                },
                {
                  name: "muteToggle",
                  description: "Toggle mute/unmute on the system volume.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "requestPowerAction",
                  description: "FIRST STEP for dangerous power actions. Generates a confirmation token. Tell the user verbally, then call executePowerAction with the token if they confirm. Actions: shutdown, restart, sleep, lock.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "Power action: shutdown, restart, sleep, lock." } }, required: ["action"] }
                },
                {
                  name: "executePowerAction",
                  description: "SECOND STEP: execute a previously-confirmed power action. Requires a valid execute_token from requestPowerAction. Single-use, expires in 60 seconds.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "The confirmed power action." }, execute_token: { type: Type.STRING, description: "Confirmation token from requestPowerAction." } }, required: ["action", "execute_token"] }
                },
                {
                  name: "minimizeWindow",
                  description: "Minimize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match (optional, defaults to active window)." } } }
                },
                {
                  name: "maximizeWindow",
                  description: "Maximize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "closeWindow",
                  description: "Close the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "switchApplication",
                  description: "Switch to a named application window, or cycle Alt+Tab if no title given.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to switch to." } } }
                },
                {
                  name: "copySelected",
                  description: "Copy selected text: sends Ctrl+C and reads the clipboard.",
                  parameters: { type: Type.OBJECT, properties: { wait: { type: Type.NUMBER, description: "Seconds to wait after Ctrl+C (default 0.35)." } } }
                },
                {
                  name: "pasteClipboard",
                  description: "Paste text into the active input. Writes text to clipboard then sends Ctrl+V.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to paste. If omitted, pastes current clipboard." } } }
                },
                {
                  name: "getClipboard",
                  description: "Read the current clipboard text content.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max chars (default 1000)." } } }
                },
                {
                  name: "clearClipboard",
                  description: "Empty the clipboard.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "takeScreenshot",
                  description: "Capture the full screen. Optionally include base64 image data.",
                  parameters: { type: Type.OBJECT, properties: { include_image: { type: Type.BOOLEAN, description: "Include base64 JPEG image (default false)." }, max_dim: { type: Type.INTEGER, description: "Max image dimension (default 1280)." } } }
                },
                {
                  name: "saveScreenshot",
                  description: "Save a screenshot to Pictures/SaraScreenshots.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Optional filename prefix." } } }
                },
                {
                  name: "analyzeScreenshot",
                  description: "Take a screenshot and run OCR to extract visible text from the screen.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "readScreen",
                  description: "OCR the active window and return its title plus visible text.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "desktopBrowserOpen",
                  description: "Open a URL in the desktop Playwright automation browser (real Chromium, separate from holographic UI).",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL to open." } }, required: ["url"] }
                },
                {
                  name: "desktopBrowserSearch",
                  description: "Search within the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." }, engine: { type: Type.STRING, description: "Engine: google, youtube, github, duckduckgo, bing." } }, required: ["query"] }
                },
                {
                  name: "desktopBrowserState",
                  description: "Read the authoritative native state of the background automation browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserClick",
                  description: "Click an element in the desktop automation browser by CSS selector or text.",
                  parameters: { type: Type.OBJECT, properties: { selector: { type: Type.STRING, description: "CSS selector." }, text: { type: Type.STRING, description: "Text to find and click." } } }
                },
                {
                  name: "desktopBrowserType",
                  description: "Type text into the active element in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to type." }, selector: { type: Type.STRING, description: "Optional CSS selector for a specific input." }, clear: { type: Type.BOOLEAN, description: "Clear before typing (default true)." } }, required: ["text"] }
                },
                {
                  name: "desktopBrowserFillForm",
                  description: "Fill multiple form fields and optionally submit in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { fields: { type: Type.OBJECT, description: "Object of selector -> value pairs." }, submit: { type: Type.STRING, description: "Optional submit button selector." } }, required: ["fields"] }
                },
                {
                  name: "desktopBrowserOpenTab",
                  description: "Open a new tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL for the new tab." } } }
                },
                {
                  name: "desktopBrowserCloseTab",
                  description: "Close the active tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoBack",
                  description: "Navigate back in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoForward",
                  description: "Navigate forward in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserScroll",
                  description: "Scroll the desktop automation browser page.",
                  parameters: { type: Type.OBJECT, properties: { direction: { type: Type.STRING, description: "Scroll direction: up or down." }, amount: { type: Type.INTEGER, description: "Pixels to scroll (default 500)." } } }
                },
                {
                  name: "createPythonFile",
                  description: "Create a Python (.py) file with content.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Python code content." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "writeCodeFile",
                  description: "Create a code file in any language with appropriate extension.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Code content." }, language: { type: Type.STRING, description: "Language name (e.g. 'python', 'javascript', 'html')." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "createProjectFolder",
                  description: "Create a project folder structure with optional subfolders and starter files.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Project root folder path." }, subfolders: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of subfolder names." }, scaffold_standard: { type: Type.BOOLEAN, description: "Create src, tests, docs subfolders." }, files: { type: Type.OBJECT, description: "Object of relative-path -> content for starter files." } }, required: ["path"] }
                },
                {
                  name: "runPythonScript",
                  description: "Execute a Python script and capture stdout, stderr, and exit code. Has a configurable timeout.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Script path." }, args: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Script arguments." }, timeout: { type: Type.INTEGER, description: "Timeout in seconds (default 30)." } }, required: ["path"] }
                },
                {
                  name: "systemInfo",
                  description: "Get system resource usage: CPU %, RAM %, disk usage, uptime, OS info.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "gpuInfo",
                  description: "Get NVIDIA GPU stats: utilization %, VRAM usage, temperature. Graceful fallback if no NVIDIA GPU.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "temperatureInfo",
                  description: "Get available temperature readings (CPU, GPU, etc.). Best-effort on Windows.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                // --- V2: Brightness control ---
                {
                  name: "brightnessUp",
                  description: "Increase screen brightness by a step (default 10%). Use when user says 'increase brightness' or 'make screen brighter'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to increase (default 10)." }
                    }
                  }
                },
                {
                  name: "brightnessDown",
                  description: "Decrease screen brightness by a step (default 10%). Use when user says 'decrease brightness' or 'dim screen'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to decrease (default 10)." }
                    }
                  }
                },
                {
                  name: "setBrightness",
                  description: "Set screen brightness to an exact level. Use when user says 'set brightness to 50%' or 'brightness 80'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      percent: { type: Type.NUMBER, description: "Target brightness 0-100." }
                    },
                    required: ["percent"]
                  }
                },
                // --- V2: Windows auto-start management ---
                {
                  name: "enableAutoStart",
                  description: "Enable SARA to launch automatically when Windows starts. Creates a silent startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "disableAutoStart",
                  description: "Disable SARA auto-start on Windows login. Removes the startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "getAutoStartStatus",
                  description: "Check whether SARA is currently configured to auto-start on Windows login.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraUniversalCommand",
                  description: "Send a complex multi-step user instruction to the Universal Command execution engine to parse, build a plan, and run multiple desktop tools sequentially.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      instruction: { type: Type.STRING, description: "The original user utterance or translated command instructing SARA to do a complex desktop workflow." }
                    },
                    required: ["instruction"]
                  }
                },
                {
                  name: "saraSetMode",
                  description: "Sets SARA's personality mode (e.g. PROFESSIONAL, FRIENDLY, NORMAL, COMPANION). Use this when the user explicitly asks you to change mode.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      mode: { type: Type.STRING, description: "The mode to switch to. Must be NORMAL, PROFESSIONAL, FRIENDLY, or COMPANION." }
                    },
                    required: ["mode"]
                  }
                },
                {
                  name: "saraScreenMonitorStart",
                  description: "Start background screen monitoring and capture snapshots or events on an interval.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      interval: { type: Type.NUMBER, description: "Seconds between captures (default 5)." },
                      max_events: { type: Type.INTEGER, description: "Maximum number of events to keep." },
                      capture_images: { type: Type.BOOLEAN, description: "Capture image frames while monitoring." }
                    }
                  }
                },
                {
                  name: "saraScreenMonitorStop",
                  description: "Stop the background screen monitor.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraScreenMonitorStatus",
                  description: "Report whether screen monitoring is active and summarize the current state.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraScreenMonitorSample",
                  description: "Capture a single screen sample immediately for analysis.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraScreenLiveStart",
                  description: "Start a lightweight live screen capture loop for quick monitoring.",
                  parameters: { type: Type.OBJECT, properties: { interval: { type: Type.NUMBER, description: "Seconds between captures." } } }
                },
                {
                  name: "saraScreenLiveStop",
                  description: "Stop the live screen capture loop.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraScreenLiveStatus",
                  description: "Check the status of the live screen capture loop.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "saraProactiveEvaluate",
                  description: "Evaluate whether a grounded, useful proactive interaction is appropriate. Prefer WAIT during quiet or focused work.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      context: { type: Type.OBJECT, description: "Compact context: activity, idle duration, current task, previous topic, relevant memory, quiet mode, or important event." }
                    }
                  }
                },
                {
                  name: "saraProactiveRecordOutcome",
                  description: "Record whether the user engaged with a proactive interaction so future timing can improve.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      accepted: { type: Type.BOOLEAN },
                      topic: { type: Type.STRING, description: "Optional non-sensitive topic label." }
                    },
                    required: ["accepted"]
                  }
                },
                {
                  name: "saraEmotionalState",
                  description: "Read or update SARA's computational emotional state. This is simulated interaction state, not a claim of biological emotion.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      event: { type: Type.STRING },
                      confidence: { type: Type.NUMBER }
                    }
                  }
                },
                {
                  name: "saraQuietMode",
                  description: "Enable or disable proactive speech while preserving critical safety behavior.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: { enabled: { type: Type.BOOLEAN } },
                    required: ["enabled"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            // ── Audio chunk: forward IMMEDIATELY, zero blocking ──────────────
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              if (!firstAudioLogged && responseStartedAt > 0) {
                firstAudioLogged = true;
                appendLog("voice.log", `first_audio_latency_ms=${Date.now() - responseStartedAt} session=${sessionId}`);
              }
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }

            // Interruption flag — forward immediately
            if (message.serverContent?.interrupted) {
              console.log("[Sara Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Turn Complete — notify client immediately, defer all DB work
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));

              // Capture snapshot of response text NOW (sync), then defer all I/O
              const capturedText = currentModelResponseText.trim();
              currentModelResponseText = "";

              if (capturedText) {
                dialogueHistory.push({ role: "model", text: capturedText });
              }

              // Fire-and-forget: DB writes and memory consolidation don't block audio
              (async () => {
                try {
                  if (capturedText) {
                    await appendConversationMessage({
                      id: newMessageId(),
                      conversationId: conversation.id,
                      role: "assistant",
                      content: capturedText,
                      timestamp: new Date().toISOString(),
                    });
                  }
                  await upsertSession({
                    sessionId,
                    conversationId: conversation.id,
                    device: "browser",
                    connectionStatus: "online",
                    createdAt: conversation.createdAt,
                    lastSeen: new Date().toISOString(),
                    lastMessageId: dialogueHistory.length
                      ? dialogueHistory[dialogueHistory.length - 1].role === "user"
                        ? dialogueHistory[dialogueHistory.length - 1].text
                        : undefined
                      : undefined,
                    lastTaskId: undefined,
                    reconnectAttempts,
                  });
                  const updated = await processConversationSlice(apiKey, dialogueHistory);
                  if (updated) {
                    console.log("[Memory Sync] Sending refreshed memory list to client.");
                    clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                  }
                } catch (err) {
                  console.error("[Memory Sync] Error running background consolidation:", err);
                }
              })();
            }

            // User transcription — forward immediately, defer DB write
            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              responseStartedAt = Date.now();
              firstAudioLogged = false;
              lastUserActivityAt = Date.now();
              scheduleProactiveEvaluation();
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
              const lowerUserText = userTextOutput.toLowerCase();
              const interactionEvent = /\b(frustrated|annoyed|stuck|hate|not working)\b/.test(lowerUserText)
                ? "user_frustrated"
                : /\b(working|fixed|solved|got it|it works)\b/.test(lowerUserText)
                  ? "user_success"
                  : /\b(excited|amazing|awesome|great news)\b/.test(lowerUserText)
                    ? "user_excited"
                    : /\b(serious|urgent|safety|dangerous)\b/.test(lowerUserText)
                      ? "serious_topic"
                      : "user_speaking";
              void callDesktopAgent("saraEmotionalState", { event: interactionEvent, confidence: 0.6 })
                .then((emotionResult) => {
                  if (emotionResult.ok) {
                    clientWs.send(JSON.stringify({ type: "emotional_state", state: emotionResult.result }));
                  }
                })
                .catch((error) => console.error("[Emotion] State update failed:", error));
              void handleLocalMemoryCommand(userTextOutput)
                .then((localMemory) => {
                  if (localMemory.handled) {
                    clientWs.send(JSON.stringify({ type: "local_memory", ...localMemory }));
                  }
                })
                .catch((error) => console.error("[Local Memory] Command failed:", error));
              // Defer DB write — do not block next audio packet
              (async () => {
                try {
                  await appendConversationMessage({
                    id: newMessageId(),
                    conversationId: conversation.id,
                    role: "user",
                    content: userTextOutput,
                    timestamp: new Date().toISOString(),
                  });
                } catch (err) {
                  console.error("[Transcription] DB write failed:", err);
                }
              })();
            }

            if (message.toolCall?.functionCalls?.length) {
              const toolResponsePromises: Promise<void>[] = [];

              for (const fc of message.toolCall.functionCalls) {
                if (!fc.name || typeof fc.name !== "string") {
                  continue;
                }

                console.log(`[Function Call]: ${fc.name}`, fc.args);
                void appendToolCall({
                  id: fc.id || newToolCallId(),
                  sessionId,
                  conversationId: conversation.id,
                  toolName: fc.name,
                  args: fc.args ?? {},
                  timestamp: new Date().toISOString(),
                }).catch((error) => console.error("[Tool Call] Deferred persistence failed:", error));

                const args = (fc.args ?? {}) as Record<string, unknown>;

                if (fc.name === "camera_vision") {
                  const action = String(args.action || "status");
                  const allowed = new Set(["start", "stop", "analyze", "status"]);
                  const result = allowed.has(action)
                    ? { ok: true, action, message: action === "start" ? "Camera activation requested." : action === "stop" ? "Camera stop requested." : action === "analyze" ? "Camera analysis requested." : "Camera status requested." }
                    : { ok: false, error: "Invalid camera vision action." };
                  clientWs.send(JSON.stringify({ type: "vision_action", action, question: args.question || "" }));
                  session.sendToolResponse({
                    functionResponses: [{ name: fc.name, response: { output: { result } }, id: fc.id }],
                  });
                } else if (fc.name === "saveCustomMemory") {
                  try {
                    const category = typeof args.category === "string" ? (args.category as MemoryCategory) : undefined;
                    const text = typeof args.text === "string" ? args.text : undefined;
                    if (category && text) {
                      const mList = await loadMemories();
                      const timestamp = new Date().toISOString();
                      const newMemory: Memory = {
                        id: Math.random().toString(36).substring(2, 11),
                        category,
                        text,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      };
                      mList.push(newMemory);
                      await saveMemories(mList);

                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: "Memory successfully captured and persisted in connections core." } },
                            id: fc.id,
                          },
                        ],
                      });
                    } else {
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: "Memory save request missing category or text." } },
                            id: fc.id,
                          },
                        ],
                      });
                    }
                  } catch (err: any) {
                    console.error("saveCustomMemory execution failure:", err);
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: { result: `Memory save failed: ${err.message || err}` } },
                          id: fc.id,
                        },
                      ],
                    });
                  }
                } else if (fc.name === "saraSetMode") {
                  try {
                    const mode = fc.args.mode as string;
                    if (["NORMAL", "PROFESSIONAL", "FRIENDLY", "COMPANION"].includes(mode)) {
                      setSaraMode(mode as any);
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: `Mode successfully set to ${mode}.` } },
                            id: fc.id,
                          },
                        ],
                      });
                    } else {
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: `Error: Invalid mode: ${mode}. Must be NORMAL, PROFESSIONAL, FRIENDLY, or COMPANION.` } },
                            id: fc.id,
                          },
                        ],
                      });
                    }
                  } catch (e: any) {
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: { result: `Error setting mode: ${e.message || String(e)}` } },
                          id: fc.id,
                        },
                      ],
                    });
                  }
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  const toolName = fc.name;
                  if (isAsyncAutomationTool(toolName)) {
                    const requestId = fc.id || newToolCallId();
                    const operationId = `${requestId}-${toolName}`;
                    const payloadArgs = { ...(fc.args as Record<string, unknown>), request_id: requestId, operation_id: operationId };
                    const queued = automationOrchestrator.submit({
                      tool: toolName,
                      args: payloadArgs,
                      priority: toolName.startsWith("youtube_") || toolName.startsWith("browser") ? "NORMAL" : "HIGH",
                      sessionId,
                      conversationId: conversation.id,
                    });
                    session.sendToolResponse({
                      functionResponses: [{
                        name: toolName,
                        response: { output: {
                          status: "QUEUED",
                          task_id: queued.task_id,
                          result: `${toolName} queued for background execution.`,
                        } },
                        id: fc.id,
                      }],
                    });
                    continue;
                  }
                  toolResponsePromises.push((async () => {
                    console.log(`[Desktop Agent] Routing ${toolName} to Python backend...`);
                    try {
                      const agentResult = await callDesktopAgent(toolName, fc.args as Record<string, unknown>);
                      if (agentResult.ok) {
                        const output = agentResult.result ?? { result: "Done." };
                        session.sendToolResponse({
                          functionResponses: [{
                            name: toolName,
                            response: { output },
                            id: fc.id,
                          }],
                        });
                      } else {
                        const errMsg = agentResult.error || "Desktop agent error.";
                        console.error(`[Desktop Agent] Error for ${toolName}:`, errMsg);
                        session.sendToolResponse({
                          functionResponses: [{
                            name: toolName,
                            response: { output: { result: `Desktop control error: ${errMsg}` } },
                            id: fc.id,
                          }],
                        });
                      }
                    } catch (err: any) {
                      console.error(`[Desktop Agent] Exception for ${toolName}:`, err);
                      session.sendToolResponse({
                        functionResponses: [{
                          name: toolName,
                          response: { output: { result: `Desktop agent exception: ${err.message || err}` } },
                          id: fc.id,
                        }],
                      });
                    }
                  })());
                } else {
                  clientWs.send(JSON.stringify({
                    type: "toolCall",
                    callId: fc.id,
                    name: fc.name,
                    args: fc.args,
                  }));
                }
              }

              if (toolResponsePromises.length > 0) {
                try {
                  await Promise.all(toolResponsePromises);
                  console.log(`[Tool Response] All ${toolResponsePromises.length} tool response(s) sent successfully.`);
                } catch (err) {
                  console.error("[Tool Response] Error awaiting tool responses:", err);
                }
              }
            }
          },
          onclose: async () => {
            console.log("Gemini Live session closed");
            if (proactiveTimer) clearTimeout(proactiveTimer);
            unsubscribeAutomation();
            await upsertSession({
              sessionId,
              conversationId: conversation.id,
              device: "browser",
              connectionStatus: "offline",
              createdAt: conversation.createdAt,
              lastSeen: new Date().toISOString(),
              reconnectAttempts,
            });
            clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
          }
        }
      });
      
      const proactiveIdleDelayMs = 10 * 60 * 1000;
      let proactiveTimer: NodeJS.Timeout | undefined;
      let lastUserActivityAt = Date.now();
      let proactiveInFlight = false;
      const recentUserText = [...recent]
        .reverse()
        .find((message: any) => message.role === "user")?.content || "";
      const unfinishedTopic = /\b(?:tomorrow|later|next time|still need to|need to finish|work on|fix|continue)\b/i.test(recentUserText)
        ? String(recentUserText).slice(0, 160)
        : "";
      const scheduleProactiveEvaluation = () => {
        if (proactiveTimer) clearTimeout(proactiveTimer);
        proactiveTimer = setTimeout(async () => {
          if (proactiveInFlight || Date.now() - lastUserActivityAt < proactiveIdleDelayMs) {
            scheduleProactiveEvaluation();
            return;
          }
          proactiveInFlight = true;
          try {
            const evaluationResult = await callDesktopAgent("saraProactiveEvaluate", {
              context: {
                activity_level: "idle",
                idle_seconds: Math.round((Date.now() - lastUserActivityAt) / 1000),
                unfinished_topic: unfinishedTopic,
                previous_topic: unfinishedTopic,
                recent_conversation: recentUserText ? "relevant_previous_topic" : "none",
              },
            });
            const evaluation = (evaluationResult.result as any)?.result || evaluationResult.result;
            const action = String(evaluation?.action || "WAIT").toUpperCase();
            const topic = String(evaluation?.topic?.topic || unfinishedTopic || "").trim();
            clientWs.send(JSON.stringify({ type: "proactive_opportunity", evaluation }));
            if (evaluationResult.ok && ["ASK", "SAY"].includes(action) && topic) {
              const liveSession = session as any;
              if (typeof liveSession.sendClientContent === "function") {
                liveSession.sendClientContent({
                  turns: [{ role: "user", parts: [{ text: `[INTERNAL PROACTIVE OPPORTUNITY] The user has been idle. Decide whether a brief natural check-in is useful, using only this grounded topic. Do not claim certainty about feelings. Topic: ${topic}` }] }],
                  turnComplete: true,
                });
              }
            }
          } catch (error) {
            console.error("[Proactive] Evaluation failed:", error);
          } finally {
            proactiveInFlight = false;
          }
        }, proactiveIdleDelayMs);
      };
      scheduleProactiveEvaluation();

      clientWs.send(JSON.stringify({ type: "status", status: "connected", conversationId: conversation.id, sessionId }));
      
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());

          if (msg.audio) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
              });
            } catch (err) {
              console.error("Error forwarding audio frame to Gemini:", err?.stack || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `AudioForwardError: ${err?.message || err}` })); } catch (e) {}
            }

          } else if (msg.type === "video" && msg.video) {
            try {
              // Validate base64 by attempting a Buffer decode — this will throw if invalid
              try {
                Buffer.from(msg.video, 'base64');
              } catch (decodeErr) {
                throw new Error(`InvalidBase64Video: ${decodeErr?.message || decodeErr}`);
              }

              session.sendRealtimeInput({
                video: { data: msg.video, mimeType: "image/jpeg" }
              });
            } catch (err) {
              console.error("Error forwarding video frame to Gemini:", err?.stack || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `VideoForwardError: ${err?.message || err}` })); } catch (e) {}
            }

          } else if (msg.type === "toolResponse") {
            try {
              session.sendToolResponse({
                functionResponses: [
                  {
                    name: msg.name,
                    response: { output: msg.output },
                    id: msg.id
                  }
                ]
              });
            } catch (err) {
              console.error("Error forwarding toolResponse to Gemini:", err?.stack || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `ToolResponseForwardError: ${err?.message || err}` })); } catch (e) {}
            }
          }
        } catch (e) {
          console.error("Error parsing client WS message or unexpected error:", e?.stack || e);
          try { clientWs.send(JSON.stringify({ type: "error", error: `ClientMessageParseError: ${e?.message || e}` })); } catch (ee) {}
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        if (proactiveTimer) clearTimeout(proactiveTimer);
        try {
          session.close();
        } catch (e) {}
      });
      
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: `Could not connect to Gemini: ${err.message || err}` 
      }));
      clientWs.close();
    }
  });

  // If wake was configured earlier, start the listener now that
  // `broadcastToClients` is available for UI notifications.
  if (deferredWakeConfig) {
    try {
      const settings = deferredWakeConfig.settings;
      const impl = settings?.wake?.impl || './src/wake/porcupineWake';
      try {
        const mod = await import(impl);
        const WakeClass = mod.default || mod.NullWake || mod.WakeListener || mod;
        let lastWakeAt = 0;
        wakeListener = new WakeClass(async (info: any) => {
          try {
            const now = Date.now();
            if (now - lastWakeAt < 1200) return; // simple debounce
            lastWakeAt = now;
            console.log('[Wake] detected', info);
            try { broadcastToClients({ type: 'wake', phrase: info?.phrase || 'SARA', confidence: info?.confidence || 0.6 }); } catch (e) {}
            // Ask desktop agent to suggest or otherwise prime the voice path.
            try {
              await ensureDesktopAgent();
              callDesktopAgent('saraCompanionSuggestNext', { hint: 'Wake detected' }).catch(() => {});
            } catch (e) {}
          } catch (e) { /* swallow */ }
        }, { phrase: settings?.wake?.phrase || 'SARA', threshold: settings?.wake?.threshold || 0.6 });
        await wakeListener.start();
        console.log('[Wake] listener started (deferred)');
      } catch (e) {
        console.warn('[Wake] failed to start wake listener (deferred):', String(e));
      }
    } catch (e) { console.warn('[Wake] deferred init failed', String(e)); }
  }

  // Serve custom static assets folder
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            "**/data/**",
            "**/conversations.json",
            "**/conversations_*.json",
            "**/conversations_mobile.json",
            "**/sessions.json",
            "**/memories.json",
            "**/tool_calls.json",
            "**/settings.json",
          ],
        },
      },
      appType: "spa",
    });
    
    // Mount Cognitive Routes BEFORE Vite middleware to take precedence
    app.use("/", cognitiveRoutes);
    
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Admin webhooks UI (simple file)
  app.get('/admin/webhooks', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'admin_webhooks.html'));
  });

  // Admin security dashboard (separate from main UI)
  app.get('/admin/security', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'admin_security.html'));
  });

  app.get('/admin/notifications', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'admin_notifications.html'));
  });

  app.get('/admin_notifications.js', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'admin_notifications.js'));
  });

  server.listen(PORT, "0.0.0.0", () => {
    logStartup(`SARA V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot.
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`)
    );
    // Wire the desktop agent bridge used by the background TaskRunner.
    (async () => {
      try {
        // Initialize TaskRunner with the runtime `callDesktopAgent` implementation.
        // Avoid assigning into the imported module namespace to prevent read-only
        // property errors in some transpilation/runtime scenarios.
        const { initTaskRunner } = await import('./server_task_manager');
        initTaskRunner(callDesktopAgent);
        console.log('[Server] TaskRunner initialized');
        // Attach TaskRunner events for broadcasting
        try {
          const { getTaskRunner } = await import('./server_task_manager');
          const runner = getTaskRunner();
          if (runner) {
            runner.on('taskUpdated', (task: any) => {
              broadcastToClients({ type: 'task:update', task });
            });
            runner.on('taskStarted', (task: any) => {
              broadcastToClients({ type: 'task:started', task });
            });
            runner.on('taskCompleted', (task: any) => {
              broadcastToClients({ type: 'task:completed', task });
              // Fire webhooks for completed tasks
              try { notifyWebhooks('task:completed', task); } catch (e) { }
            });
            runner.on('taskProgress', ({ taskId, progress, task }: any) => {
              broadcastToClients({ type: 'task:progress', taskId, progress, task });
              try { notifyWebhooks('task:progress', { taskId, progress, task }); } catch (e) { }
            });
          }
        } catch (e) {
          console.warn('[Server] Failed to subscribe TaskRunner events', e);
        }
      } catch (e) {
        console.warn('[Server] TaskRunner init failed', e);
      }
    })();
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});
