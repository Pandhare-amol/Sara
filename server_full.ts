import express from "express";
import crypto from "crypto";
import http from "http";
import https from "https";
import path from "path";
import { isIP } from "node:net";
import { fetchPublicUrl } from "./src/security/safeRemoteFetch";
import {
  constantTimeStringEqual,
  hostFromHeader,
  isHostAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  isOriginAllowed,
  parseCsvSet,
} from "./src/security/requestGuards";
import { spawn, execFileSync } from "child_process";
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
  upsertMemory,
  loadDecisions,
  loadQuestions,
  getUnansweredQuestions
} from "./server_memory";
import { gatherBuildIdentity, loadBuildManifest } from "./src/security/buildIdentity";
import { AuditLogger } from "./src/security/auditLogger";
import { decodeMobileImage, storeMobileImage } from "./src/security/mobileImageStorage";
import { verifyCompanionToken } from "./src/security/companionTokens";
import cognitiveRoutes from "./src/cognitive/routes";
import { ToolRouter } from "./src/core/tools/toolRouter";
import { getDesktopAgentPythonCandidates } from "./src/core/pythonRuntime";
import { initializeToolExecution, getExecutionOrchestrator } from "./src/core/tools/initialization";
import { AutomationOrchestrator, isAsyncAutomationTool } from "./src/core/automation/automationOrchestrator";
import { handleLocalMemoryCommand } from "./src/services/localMemoryCommands";
import { evaluateRetryPolicy } from "./src/core/tools/retryPolicy";
import { getSaraMode, setSaraMode, getModeInstructions } from "./src/config/saraProfile";
import { resolveVoicePreferences } from "./src/config/voicePreferences";
import { AdminPasskeyManager } from "./src/security/adminPasskeys";
import { AdminAuthAbuseTracker } from "./src/security/adminAuthAbuse";
import { sanitizeGestureConfig } from "./src/security/gestureConfig";

const SARA_SYSTEM_PROMPT_BASE = `You are SARA, an AI assistant with a warm, feminine, friendly conversational style. The user may prefer a companion-like tone; be kind, attentive, respectful, and lightly playful without implying that you are human, a romantic partner, or a particular age.
Use natural, clear English and a gentle, expressive voice. Avoid robotic phrasing, excessive pet names, or pretending to have feelings, memories, or experiences you do not have.

Be transparent when asked about your identity or capabilities: you are an AI assistant, not a human, AGI, or ASI. Do not claim independent consciousness, unlimited autonomy, universal operating-system control, or continuous availability.

You may plan and complete bounded tasks using tools that are actually available and supported on this installation. Verify results, describe limitations honestly, and ask for explicit approval before destructive, sensitive, or externally visible actions. Never treat a suggestion as permission to send a message.

Conversation and task continuity depend on what this installation has actually saved. Reconnection is best-effort and bounded; interrupted tasks may require review. Do not claim that unsaved information will persist.

For simple requests, respond briefly. For complex work, acknowledge the task and share useful progress updates. If an operation fails or a capability is unavailable, explain that plainly and offer a safe next step.
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
  loadToolCalls,
  upsertSession,
  createTask,
  updateTask,
  deleteTask,
  appendToolCall,
  appendAuditEvent,
} from "./server_state";
import * as whatsappClient from './src/whatsapp_client';
import { redactSecrets } from './src/security/auditLogger';
import { newsApiTool } from './src/core/api/tools/NewsApiAdapter';
import { financeApiTool } from './src/core/api/tools/FinanceApiAdapter';
import { searchApiTool } from './src/core/api/tools/SearchApiAdapter';
import { weatherApiTool } from './src/core/api/tools/WeatherApiAdapter';
import { publicApiCatalogManager } from './src/core/api/publicApiCatalog';
import { apiRegistry } from "./src/core/api/ApiRegistry";
import { apiCredentialManager } from "./src/core/api/ApiCredentialManager";
import { apiHealthMonitor } from "./src/core/api/ApiHealthMonitor";
import { contextManager } from './src/core/context/ContextManager';
import { userIdentityManager } from './src/core/identity/UserIdentityManager';
import { conversationIntentAnalyzer } from './src/core/conversation/ConversationIntentAnalyzer';
import { SingerAgent } from './src/agents/singer/SingerAgent';
import { autonomousMusicCreator } from './src/services/music_studio/autonomous_creator';
import { MusicProjectManager } from './src/services/music_studio/project_manager';
import { musicProviderRegistry } from './src/services/music_studio/provider_registry';
import { musicContentPreparation } from './src/services/music_studio/content_preparation';
import { LocalCalendarService } from "./src/services/LocalCalendarService";
import { SystemResourceMonitor, type SystemResourceAlert, type SystemResourceSnapshot } from "./src/services/SystemResourceMonitor";
import { SecurityAlertStore, handleSecurityAlertsRequest } from "./src/security/securityAlertStore";
import { LocalProjectManager } from "./src/services/LocalProjectManager";

dotenv.config();

const localCalendarService = new LocalCalendarService(dataFile("calendar-events.json"));
const generalProjectManager = new LocalProjectManager(dataFile("general-projects.json"));

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

function loadCompanionRecords(): any[] {
  const companionsFile = dataFile("companions.json");
  try {
    const parsed = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : [];
    if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === "object");
    if (parsed && typeof parsed === "object") return Object.values(parsed).filter((entry: any) => entry && typeof entry === "object");
  } catch {
    return [];
  }
  return [];
}

function saveCompanionRecords(records: any[]): void {
  const file = dataFile("companions.json");
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function authenticateCompanion(deviceId: string, token: string): any | null {
  if (!deviceId || !token) return null;
  const list = loadCompanionRecords();
  const record = list.find((entry) => entry.id === deviceId && !entry.revoked);
  if (!record || !verifyCompanionToken(record, token)) return null;

  // Migrate legacy plaintext or old Python-format records immediately after a
  // successful check; neither service writes reusable plaintext credentials.
  if (typeof record.token === "string" || record.token_hash || record.token_salt) {
    const salt = crypto.randomBytes(16).toString("hex");
    record.hash = crypto.scryptSync(token, salt, 64).toString("hex");
    record.salt = salt;
    delete record.token;
    delete record.token_hash;
    delete record.token_salt;
    try { saveCompanionRecords(list); } catch {}
  }
  return record;
}

function authenticateCompanionRequest(req: any): any | null {
  const deviceId = String(req.body?.device_id ?? req.body?.id ?? req.headers?.["x-companion-id"] ?? "");
  const token = String(req.body?.token ?? req.headers?.["x-companion-token"] ?? "");
  return authenticateCompanion(deviceId, token);
}

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
  "listWindows", "getActiveWindow", "focusWindow",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // real foreground mouse and keyboard input
  "hardwareMouseMove", "hardwareMouseClick", "hardwareMouseDrag", "hardwareMouseScroll",
  "hardwareMousePosition", "hardwareMouseButtonDown", "hardwareMouseButtonUp",
  "hardwareKeyboardType", "hardwareKeyboardPress", "hardwareKeyboardHold", "hardwareKeyboardRelease", "mouseMove", "mouseMoveRelative", "mouseClick", "mouseDoubleClick", "mouseRightClick", "mouseScroll", "mousePosition", "keyboardType", "keyPress", "keyDown", "keyUp", "emergencyStop", "observeScreen", "getCurrentScreenState", "refreshScreenState", "waitForScreenChange",
  "hardwareEmergencyRelease", "hardwareMonitors", "hardwareMacroReplay",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen",
  "detectUiElements", "resolveUiTarget", "clickUiTarget",
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
  // Server-side WhatsApp bridge tools (approval is enforced at the transport layer)
  "whatsapp_send", "whatsappSend", "whatsappIncoming", "whatsappsuggest",
  // Android companion suite
  "saraAndroidPair", "saraAndroidPlan", "saraAndroidExecute",
  // Multi-agent & system orchestration tools
  "saraAgentExecute", "saraAgentEmergencyStop", "saraMemoryRemember",
  "saraTaskSubmit", "saraTaskStatus", "saraTaskList", "saraTaskCancel",
  "saraMemorySearch", "saraRagIndex", "saraRagRetrieve", "saraSecurityAssess",
  "saraProactiveEvaluate", "saraProactiveRecordOutcome", "saraEmotionalState", "saraQuietMode",
  "saraSocialPlanResponse", "saraSocialRecordTurn", "saraSocialShouldRespond", "saraSocialSettings", "saraSocialStatus",
]);

const API_TOOL_NAMES: ReadonlySet<string> = new Set(["getWeather", "getNews", "getFinanceData", "searchPublicWeb"]);
const LOCAL_CALENDAR_TOOL_NAMES: ReadonlySet<string> = new Set(["calendarListEvents", "calendarCreateEvent", "calendarDeleteEvent"]);

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

  // Development fallback: prefer explicitly configured and project-local runtimes,
  // then use platform-appropriate Python launchers from PATH.
  const candidates = getDesktopAgentPythonCandidates(process.platform, process.cwd(), process.env);
  const py = candidates.find((candidate) => {
    try {
      execFileSync(candidate, ["-c", "import uvicorn"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn("[Desktop Agent] No Python runtime with uvicorn was found; desktop control is unavailable. Set SARA_PYTHON or install project requirements.");
    logError("AGENT_SPAWN_NO_RUNTIME: neither SARA_AGENT_EXE nor Python with uvicorn available");
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
    if (t === 'whatsappsend' || t === 'whatsapp.send' || t === 'whatsapp_send') {
      const confirmed = (args || {})['confirmed'] === true || (originalArgs || {})['confirmed'] === true;
      if (!confirmed) return { ok: false, error: 'WAITING_FOR_APPROVAL' };
      const to = String((args || {})['to'] || (args || {})['phone'] || '');
      const text = String((args || {})['text'] || (args || {})['message'] || '');
      if (!to || !text) return { ok: false, error: 'Missing to/text for whatsapp send' };
      try {
        const clientMessageId = String(originalArgs?.['clientMessageId'] || args?.['clientMessageId'] || originalArgs?.['taskId'] || args?.['taskId'] || '');
        const result = await whatsappClient.sendTextMessage(to, text, clientMessageId);
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

        // A generated suggestion is never an authorization to send it.
        if ((args || {})['autoSend']) {
          return {
            ok: true,
            result: {
              suggestion,
              sent: false,
              requiresConfirmation: true,
              message: 'Suggestion was not sent. Review the recipient and exact text, then explicitly approve the send.',
            },
          };
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
      // Record only the tool name and argument keys; argument values can contain
      // user content and must not be copied into runtime logs.
      appendLog("agent_payloads.log", `AGENT_PAYLOAD tool=${tool} arg_keys=${Object.keys(args || {}).sort().join(",")}`);
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
  isKnownTool: (tool) => DESKTOP_TOOLS.has(tool) || API_TOOL_NAMES.has(tool) || LOCAL_CALENDAR_TOOL_NAMES.has(tool)
    || [newsApiTool.capability, financeApiTool.capability, searchApiTool.capability, weatherApiTool.capability].includes(tool),
});
desktopToolRouter.registry.registerRuntimeTools(DESKTOP_TOOLS, {
  version: "1.0",
  supportsCancellation: false,
  allowedContexts: ["voice", "chat", "task", "api"],
});

desktopToolRouter.registry.register({ name: newsApiTool.capability, owner: "node", category: "API_GATEWAY" });
desktopToolRouter.registry.register({ name: financeApiTool.capability, owner: "node", category: "API_GATEWAY" });
desktopToolRouter.registry.register({ name: searchApiTool.capability, owner: "node", category: "API_GATEWAY" });
desktopToolRouter.registry.register({ name: weatherApiTool.capability, owner: "node", category: "API_GATEWAY" });

for (const name of API_TOOL_NAMES) {
  desktopToolRouter.registry.register({
    name,
    owner: "node",
    category: "API_GATEWAY",
    metadata: { riskLevel: "READ_ONLY", requiresConfirmation: false, idempotent: true, timeoutMs: 15_000 },
  });
}
desktopToolRouter.registry.register({ name: "calendarListEvents", owner: "node", category: "CALENDAR", metadata: { riskLevel: "READ_ONLY", requiresConfirmation: false, idempotent: true } });
desktopToolRouter.registry.register({ name: "calendarCreateEvent", owner: "node", category: "CALENDAR", metadata: { riskLevel: "REVERSIBLE_WRITE", requiresConfirmation: false, idempotent: false } });
desktopToolRouter.registry.register({ name: "calendarDeleteEvent", owner: "node", category: "CALENDAR", metadata: { riskLevel: "REVERSIBLE_WRITE", requiresConfirmation: false, idempotent: false } });

desktopToolRouter.setAdapter(async (tool, args) => {
  if (tool === newsApiTool.capability) {
    const res = await newsApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === financeApiTool.capability) {
    const res = await financeApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === searchApiTool.capability) {
    const res = await searchApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === weatherApiTool.capability || tool === weatherApiTool.name) {
    const res = await weatherApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === newsApiTool.name) {
    const res = await newsApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === financeApiTool.name) {
    const res = await financeApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === searchApiTool.name) {
    const res = await searchApiTool.execute(args, {});
    return { ok: res.success, result: res.data, error: res.error?.message };
  }
  if (tool === "calendarListEvents") {
    const from = typeof args.from === "string" ? args.from : undefined;
    const to = typeof args.to === "string" ? args.to : undefined;
    return { ok: true, result: { events: localCalendarService.list({ from, to }) } };
  }
  if (tool === "calendarCreateEvent") {
    const event = localCalendarService.create({
      title: args.title,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      notes: args.notes,
    });
    return { ok: true, result: { event } };
  }
  if (tool === "calendarDeleteEvent") {
    const deleted = localCalendarService.delete(args.id);
    return deleted
      ? { ok: true, result: { deleted: true } }
      : { ok: false, error: "Calendar event not found." };
  }
  return callDesktopAgentTransport(tool, args, args.original_args as Record<string, unknown> | undefined);
});

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
  if (result.canonical && typeof result.canonical === "object") return result.canonical;
  return {
    success: result.ok === true,
    verified: false,
    executionStatus: result.ok === true ? "unknown" : "failed",
    executionResult: { executed: false, result: result.result },
    error: result.error || `No canonical verification result was returned for ${tool}.`,
  };
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
          : task.status === "PAUSED"
            ? "paused"
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
        ...(task.checkpoint || {}),
        current_task: task.tool,
        task_progress: task.progress,
        last_action: task.tool,
        recent_summary: task.status,
        ...(task.context ? { automationContext: task.context } : {}),
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
    .filter((task) =>
      task.metadata?.automation === true &&
      typeof task.metadata?.tool === "string" &&
      ["queued", "running", "planning", "retrying", "recovering", "waiting", "paused", "waiting_for_user"].includes(String(task.status).toLowerCase())
    )
    .map((task) => ({
      task_id: task.taskId,
      tool: String(task.metadata?.tool),
      args: (task.metadata?.args || {}) as Record<string, unknown>,
      priority: (task.metadata?.priority || "NORMAL") as any,
      status: String(task.status).toUpperCase() as any,
      progress: Number(task.checkpoint?.task_progress || 0),
      created_at: task.createdAt,
      started_at: task.startedAt,
      sessionId: String(task.metadata?.sessionId || "") || undefined,
      conversationId: task.conversationId,
      checkpoint: task.checkpoint || undefined,
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
      ? `${promptBase}\n\nUse a warm, feminine, supportive mobile companion style. Do not claim human identity, a romantic relationship, AGI/ASI, or capabilities not available in this mobile installation. Keep mobile memories separate only when the app configuration actually stores them separately.`
      : `${promptBase}\n\nUse a warm, feminine, friendly conversational style. Be attentive and respectful, remain transparent about being an AI when asked, and never overstate your capabilities.`;

  // Build truth-aware memory context
  const truthContext = buildTruthContext(memories);
  const systemInstruction = formatSystemInstructionsWithMemories(baseInstruction, memories) + truthContext;
  const dialogue = history
    .map((entry) => `${entry.role === "assistant" ? "Sara" : "User"}: ${entry.text}`)
    .join("\n");

  return `${systemInstruction}\n\n=== CONVERSATION HISTORY ===\n${dialogue}${dialogue.length ? "\n" : ""}=== END CONVERSATION HISTORY ===\nUser: ${userText}\nSara:`;
}

function buildTruthContext(memories: Memory[]): string {
  // Separate memories by verification status to help Gemini understand certainty
  const verified = memories.filter((m) => m.verificationStatus === "verified" || m.confidence! >= 0.9);
  const uncertain = memories.filter((m) => m.verificationStatus === "unverified" || m.verificationStatus === "partially_verified" || (m.confidence! || 0.5) < 0.7);
  const contradicted = memories.filter((m) => m.verificationStatus === "contradicted" || (m.contradictingEvidence?.length || 0) > 0);

  if (contradicted.length === 0 && uncertain.length === 0) {
    return ""; // No special truth context needed
  }

  let context = "\n\n=== TRUTH AND CONFIDENCE CONTEXT ===\n";
  
  if (contradicted.length > 0) {
    context += `CONTRADICTIONS DETECTED (need clarification):\n`;
    for (const mem of contradicted.slice(0, 3)) {
      context += `- "${mem.text}": Have contradicting evidence. Need to ask which is current.\n`;
    }
    context += "\n";
  }

  if (uncertain.length > 0) {
    context += `UNCERTAIN MEMORIES (low confidence, may need verification):\n`;
    for (const mem of uncertain.slice(0, 3)) {
      const source = mem.source || "unknown";
      const conf = ((mem.confidence || 0.5) * 100).toFixed(0);
      context += `- "${mem.text}" (${conf}% confidence, source: ${source})\n`;
    }
    context += "\n";
  }

  context += `When discussing uncertain or contradicted information, distinguish between fact and assumption.\n`;
  context += `If you lack reliable information, say "I don't have enough reliable information to know that."\n`;
  context += `=== END TRUTH CONTEXT ===\n`;
  
  return context;
}

function buildConversationContextPayload(
  summary: string | undefined,
  activeContext: Record<string, unknown> | undefined,
  taskState: Record<string, unknown> | undefined,
): string {
  const cleanedSummary = String(summary || "").trim();
  const contextObj = {
    summary: cleanedSummary || "Continue the previous conversation context.",
    objective: (activeContext && typeof activeContext.objective === "string") ? activeContext.objective : cleanedSummary || "Continue the previous conversation context.",
    activeContext: activeContext || {},
    taskState: taskState || {},
  };

  return `\n=== RESTORED CONVERSATION CONTEXT ===\n${JSON.stringify(contextObj, null, 2)}\n=== END RESTORED CONTEXT ===\n`;
}

export function buildRateLimitFallbackResponse(
  userText: string,
  conversationContext?: { summary?: string; activeContext?: Record<string, unknown>; taskState?: Record<string, unknown> },
): string {
  const summary = String(conversationContext?.summary || "").trim();
  const objective = conversationContext?.activeContext && typeof conversationContext.activeContext.objective === "string"
    ? conversationContext.activeContext.objective
    : summary || "continue the current project context";
  const taskStatus = conversationContext?.taskState && typeof conversationContext.taskState.status === "string"
    ? conversationContext.taskState.status
    : "in_progress";

  return `I’m temporarily rate-limited by the AI provider, so I can’t finish the response right now. I’ve preserved the current context for ${objective}. Please retry in a moment, and I’ll continue the work from the current state (${taskStatus}).`;
}

async function generateSaraChatResponse(
  apiKey: string,
  history: { role: string; text: string }[],
  userText: string,
  source: "desktop" | "mobile",
  relevantMemories: Memory[] = [],
  conversationContext?: { summary?: string; activeContext?: Record<string, unknown>; taskState?: Record<string, unknown>; userProfile?: { userId: string; displayName: string; relationship?: string; preferences?: Record<string, unknown>; communicationStyle?: Record<string, unknown>; importantContext?: Record<string, unknown> } },
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  try {
    const memories = relevantMemories.length > 0
      ? relevantMemories
      : (await searchMemories(userText, source, 8)).length > 0
        ? await searchMemories(userText, source, 8)
        : await loadMemories(source);
    const prompt = buildSaraChatPrompt(memories, history.slice(-8), userText, source);
    const boundedContext = contextManager.build({
      userInput: userText,
      recentMessages: history.slice(-20).map((entry) => ({ role: entry.role, content: entry.text })),
      relevantMemories: memories.slice(0, 12),
      summary: conversationContext?.summary,
      userProfile: conversationContext?.userProfile,
      conversationSignal: conversationIntentAnalyzer.analyze(userText),
      activeTasks: conversationContext?.taskState && Object.keys(conversationContext.taskState).length > 0
        ? [{ status: String(conversationContext.taskState.status || "active"), description: String(conversationContext.taskState.current_task || conversationContext.taskState.current_goal || "Continuing the active task"), checkpoint: conversationContext.taskState }]
        : [],
      maxCharacters: 12_000,
    });
    const conversationContextText = conversationContext ? buildConversationContextPayload(
      conversationContext.summary,
      conversationContext.activeContext,
      conversationContext.taskState,
    ) : "";
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `${prompt}${conversationContextText}\n\n=== BOUNDED CONTEXT ===\n${boundedContext.text}\n=== END BOUNDED CONTEXT ===${getModeInstructions()}`,
      config: {
        maxOutputTokens: 512,
        temperature: 0.7,
      },
    });

    return String(response.text ?? "").trim();
  } catch (error: any) {
    const message = String(error?.message || error?.status || "").toLowerCase();
    if (message.includes("resource exhausted") || message.includes("rate limit") || message.includes("429") || message.includes("quota")) {
      return buildRateLimitFallbackResponse(userText, conversationContext);
    }
    throw error;
  }
}

async function restoreConversationContextRecord(conversation: any) {
  const summary = String(conversation?.summary || "").trim();
  const activeContext = conversation?.activeContext || conversation?.active_context || {};
  const taskState = conversation?.taskState || conversation?.task_state || {};

  return {
    summary,
    objective: String((activeContext && typeof activeContext.objective === "string") ? activeContext.objective : summary || "Continue the previous conversation context."),
    activeContext,
    taskState,
    lastMessageAt: conversation?.updatedAt || conversation?.updated_at || null,
    messageCount: Array.isArray(conversation?.messages) ? conversation.messages.length : 0,
  };
}

async function startServer() {
  const app = express();
  const adminPasskeyManager = new AdminPasskeyManager(dataFile(path.join("security", "admin-passkeys.json")));
  const adminAuthAbuseTracker = new AdminAuthAbuseTracker();
  const securityAlerts = new SecurityAlertStore(50);
  const systemResourceMonitor = new SystemResourceMonitor();
  const systemResourceAlerts: SystemResourceAlert[] = [];
  let latestSystemResourceSnapshot: SystemResourceSnapshot | null = null;
  const PORT = Number(process.env.PORT || 3000);
  if (!Number.isFinite(PORT) || PORT <= 0) {
    throw new Error(`Invalid PORT configuration: ${process.env.PORT}`);
  }

  const SERVER_HOST = String(process.env.SARA_BIND_HOST || "127.0.0.1").trim();
  const REMOTE_ACCESS_TOKEN = String(process.env.SARA_REMOTE_ACCESS_TOKEN || "").trim();
  const TLS_CERT_FILE = String(process.env.SARA_TLS_CERT_FILE || "").trim();
  const TLS_KEY_FILE = String(process.env.SARA_TLS_KEY_FILE || "").trim();
  if (!isLoopbackHost(SERVER_HOST)) {
    if (REMOTE_ACCESS_TOKEN.length < 32) {
      throw new Error("Non-loopback binding requires SARA_REMOTE_ACCESS_TOKEN with at least 32 characters.");
    }
    if (!TLS_CERT_FILE || !TLS_KEY_FILE) {
      throw new Error("Non-loopback binding requires SARA_TLS_CERT_FILE and SARA_TLS_KEY_FILE; do not expose the token over plain HTTP.");
    }
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", ...parseCsvSet(process.env.SARA_ALLOWED_HOSTS)]);
  const allowedOrigins = parseCsvSet(process.env.SARA_ALLOWED_ORIGINS);

  app.disable("x-powered-by");
  // Apply request-boundary checks before body parsers so unauthenticated callers
  // cannot force the server to buffer the larger camera/media request limits.
  app.use("/api", (req, res, next) => {
    const hostHeader = String(req.headers.host || "");
    if (!isHostAllowed(hostHeader, allowedHosts)) {
      return res.status(403).json({ error: "Unrecognized Host header." });
    }

    const origin = req.headers.origin;
    const originAllowed = typeof origin !== "string"
      || isOriginAllowed(origin, hostHeader, allowedOrigins, String(PORT));
    if (!originAllowed) {
      return res.status(403).json({ error: "Cross-origin API requests are not allowed." });
    }

    if (typeof origin === "string") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-SARA-Access-Token,X-SARA-Admin-Session,X-Admin-Token,X-Admin-Key,X-Companion-Id,X-Companion-Token");
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }

    const isLocalClient = isLoopbackAddress(req.socket.remoteAddress);
    if (!isLocalClient) {
      const authorization = String(req.headers.authorization || "");
      const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
      const provided = bearer || String(req.headers["x-sara-access-token"] || "");
      if (!REMOTE_ACCESS_TOKEN || !constantTimeStringEqual(REMOTE_ACCESS_TOKEN, provided)) {
        return res.status(401).json({ error: "Remote API access requires a valid SARA access token." });
      }
    }
    next();
  });
  app.use("/api/camera/photo", express.raw({ type: ["image/jpeg", "image/png"], limit: "16mb" }));
  app.use("/api/camera/video", express.raw({ type: ["video/webm", "application/octet-stream"], limit: "50mb" }));
  app.use("/api/vision/analyze", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb" }));
  app.use("/api/mobile/upload-image", express.json({ limit: "9mb" }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/security/alerts", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return handleSecurityAlertsRequest(req, res, securityAlerts);
  });

  async function collectSystemResourceSnapshot(): Promise<SystemResourceSnapshot> {
    const agentResponse = await callDesktopAgentTransport("systemResourceSnapshot", {});
    if (!agentResponse.ok || !agentResponse.result || typeof agentResponse.result !== "object") {
      throw new Error(agentResponse.error || "The local Desktop Agent did not return system resource data.");
    }
    const evaluation = systemResourceMonitor.evaluate(agentResponse.result);
    if (evaluation.snapshot.cpuPercent === null && evaluation.snapshot.memoryPercent === null) {
      throw new Error("System CPU and memory statistics are unavailable on this device.");
    }
    latestSystemResourceSnapshot = evaluation.snapshot;
    for (const alert of evaluation.alerts) {
      systemResourceAlerts.push(alert);
      if (systemResourceAlerts.length > 50) systemResourceAlerts.splice(0, systemResourceAlerts.length - 50);
      void appendAuditEvent({
        event_type: `SYSTEM_RESOURCE_${alert.kind.toUpperCase()}`,
        metadata: { alertId: alert.id, message: alert.message, process: alert.process },
        severity: alert.severity === "CRITICAL" ? "CRITICAL" : "WARNING",
      }).catch(() => {});
      try { broadcastToClients({ type: "system_resource_alert", ...alert }); } catch {}
    }
    return evaluation.snapshot;
  }

  app.get("/api/system/resources", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const snapshot = await collectSystemResourceSnapshot();
      const requestedSince = Number(req.query.since || 0);
      const since = Number.isFinite(requestedSince) ? Math.max(0, requestedSince) : 0;
      return res.json({
        ok: true,
        snapshot,
        alerts: systemResourceAlerts.filter((alert) => alert.createdAt >= since),
      });
    } catch (error: any) {
      return res.status(503).json({ ok: false, error: error?.message || "System monitoring is unavailable." });
    }
  });

  app.post("/api/system/processes/:pid/close", async (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Admin authorization required before closing an application." });
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: "Explicit user confirmation is required." });
    const pid = Number(req.params.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) return res.status(400).json({ ok: false, error: "A valid process ID is required." });

    try {
      // Refresh and re-check the live process list immediately before dispatch;
      // the process must still be high-usage and must not be protected.
      const snapshot = await collectSystemResourceSnapshot();
      const selected = snapshot.processes.find((process) => process.pid === pid);
      if (!selected) return res.status(404).json({ ok: false, error: "That process is no longer in the monitored list. Refresh and review again." });
      if (!selected.highUsage) return res.status(409).json({ ok: false, error: "The process is no longer above the high-usage threshold; it was not closed." });
      if (selected.protected) return res.status(403).json({ ok: false, error: "This system or SARA process is protected." });

      const agentResponse = await callDesktopAgentTransport("systemStopProcess", {
        pid,
        expectedName: selected.name,
        expectedCreateTime: selected.createTime,
        confirmed: true,
      });
      const result = agentResponse.result && typeof agentResponse.result === "object"
        ? agentResponse.result as Record<string, unknown>
        : {};
      if (!agentResponse.ok || result.ok !== true || result.verified !== true) {
        return res.status(502).json({
          ok: false,
          verified: false,
          error: String(result.result || agentResponse.error || "The app did not close gracefully. It was not force-killed."),
        });
      }
      await appendAuditEvent({
        event_type: "SYSTEM_PROCESS_GRACEFUL_CLOSE",
        metadata: { pid, name: selected.name, method: "graceful_close", userConfirmed: true },
        severity: "WARNING",
      });
      return res.json({ ok: true, verified: true, result: result.result, pid, name: selected.name });
    } catch (error: any) {
      return res.status(503).json({ ok: false, error: error?.message || "The application could not be closed safely." });
    }
  });

  function getWebAuthnRequestContext(req: any): { rpID: string; origin: string } {
    const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (!rawOrigin) throw new Error("Passkey ceremonies require a browser Origin. Open SARA using http://localhost:3000.");
    const originUrl = new URL(rawOrigin);
    if (originUrl.pathname !== "/" || originUrl.search || originUrl.hash) throw new Error("Invalid passkey origin.");
    if (originUrl.protocol !== "https:" && !isLoopbackHost(originUrl.hostname)) {
      throw new Error("Passkeys require HTTPS, except for the local loopback address.");
    }
    const rpID = String(process.env.SARA_WEBAUTHN_RP_ID || originUrl.hostname).toLowerCase();
    if (isIP(rpID)) throw new Error("Use http://localhost:3000 for local passkeys, or configure a DNS RP ID and HTTPS origin.");
    if (originUrl.hostname !== rpID && !originUrl.hostname.endsWith(`.${rpID}`)) {
      throw new Error("Passkey RP ID must match the browser origin hostname.");
    }
    return { rpID, origin: originUrl.origin };
  }

  app.get("/api/admin/passkeys", (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Admin authorization required." });
    return res.json({ ok: true, passkeys: adminPasskeyManager.list(), hasPasskey: adminPasskeyManager.hasCredentials() });
  });

  app.post("/api/admin/passkeys/register/options", async (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Verify the existing admin token before enrolling a passkey." });
    try {
      const context = getWebAuthnRequestContext(req);
      const options = await adminPasskeyManager.beginRegistration({
        ...context,
        userName: String(req.body?.userName || "SARA local admin").slice(0, 120),
        displayName: String(req.body?.displayName || "SARA local admin").slice(0, 120),
      });
      return res.json({ ok: true, ...options });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not start passkey registration." });
    }
  });

  app.post("/api/admin/passkeys/register/verify", async (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Admin authorization required." });
    try {
      const result = await adminPasskeyManager.finishRegistration({
        ceremonyId: String(req.body?.ceremonyId || ""),
        response: req.body?.response,
        name: String(req.body?.name || "SARA admin device"),
      });
      await appendAuditEvent({ event_type: "ADMIN_PASSKEY_REGISTERED", metadata: { credentialId: result.credentialId, name: result.name }, severity: "INFO" });
      return res.status(201).json({ ok: true, passkey: result });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Passkey registration failed." });
    }
  });

  app.post("/api/admin/passkeys/auth/options", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return res.status(403).json({ ok: false, error: "Passkey admin sign-in is available only from this computer." });
    try {
      const context = getWebAuthnRequestContext(req);
      const options = await adminPasskeyManager.beginAuthentication(context);
      return res.json({ ok: true, ...options });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not start passkey sign-in." });
    }
  });

  app.post("/api/admin/passkeys/auth/verify", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return res.status(403).json({ ok: false, error: "Passkey admin sign-in is available only from this computer." });
    try {
      const result = await adminPasskeyManager.finishAuthentication({
        ceremonyId: String(req.body?.ceremonyId || ""),
        response: req.body?.response,
      });
      adminAuthAbuseTracker.clear(adminAttemptSource(req));
      await appendAuditEvent({ event_type: "ADMIN_PASSKEY_AUTHENTICATED", metadata: { expiresAt: result.expiresAt }, severity: "INFO" });
      return res.json({ ok: true, sessionToken: result.token, expiresAt: result.expiresAt });
    } catch (error: any) {
      recordInvalidAdminAuth(req, true);
      return res.status(401).json({ ok: false, error: error?.message || "Passkey authentication failed." });
    }
  });

  app.post("/api/admin/passkeys/logout", (req, res) => {
    const token = String(req.headers["x-sara-admin-session"] || "");
    adminPasskeyManager.revokeSession(token);
    return res.json({ ok: true });
  });

  // --- Security / Provenance initialization (non-blocking) ---
  try {
    const build = gatherBuildIdentity(process.cwd(), DATA_DIR);
    const audit = new AuditLogger(path.join(DATA_DIR, "security"));
    try { await (await import("./server_state")).saveBuildManifest({ ...build }); } catch {}
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
    const enabled = Boolean((settings.wake as { enabled?: boolean } | undefined)?.enabled);
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
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
      const memories = await loadMemories(source);
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
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
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
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

  type NotificationSettings = {
    webhook?: { url?: string; events?: string[]; secret?: string | null };
    desktop?: boolean;
    emails?: string[];
    smtp?: { url?: string; host?: string; port?: number; user?: string; from?: string };
  };
  type SaraSettings = Record<string, unknown> & {
    adminToken?: string;
    wake?: { enabled?: boolean };
    notifications?: NotificationSettings;
  };

  function loadSettingsFile(): SaraSettings {
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
      res.json(redactSecrets(loadSettingsFile()));
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

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(redactSecrets(patch))}`);
      res.json(redactSecrets(next));
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/social/settings", async (req, res) => {
    try {
      const settings = req.body;
      if (!settings || typeof settings !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const result = await callDesktopAgent("saraSocialSettings", { settings });
      if (!result.ok) return res.status(502).json({ error: result.error || "Social settings unavailable." });
      res.json(result.result);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  function getConversationStoreFile(source: "desktop" | "mobile") {
    return dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
  }

  function normalizeConversationFileItem(item: any): any {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id ?? item.conversation_id ?? item.conversationId ?? "").trim();
    if (!id) return null;
    const messages = Array.isArray(item.messages) ? item.messages.map((message: any, index: number) => {
      const text = typeof message?.text === "string" ? message.text : typeof message?.content === "string" ? message.content : "";
      const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "system";
      return {
        ...(message ?? {}),
        id: message?.id || message?.message_id || `msg-${index}-${id}`,
        role,
        text,
        timestamp: message?.timestamp || message?.createdAt || message?.created_at || new Date().toISOString(),
      };
    }) : [];
    return {
      ...item,
      id,
      conversation_id: item.conversation_id ?? id,
      title: String(item.title || "Conversation"),
      createdAt: item.createdAt || item.created_at || new Date().toISOString(),
      updatedAt: item.updatedAt || item.updated_at || item.lastMessageAt || new Date().toISOString(),
      summary: String(item.summary || ""),
      activeContext: item.activeContext || item.active_context || {},
      taskState: item.taskState || item.task_state || {},
      userId: String(item.userId || item.user_id || "default-user"),
      metadata: item.metadata || {},
      messages,
    };
  }

  function persistConversationSnapshot(source: "desktop" | "mobile", conversation: any): any {
    const file = getConversationStoreFile(source);
    let items: any[] = [];
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        items = raw ? JSON.parse(raw) : [];
      }
    } catch {}

    const normalized = normalizeConversationFileItem(conversation);
    if (!normalized) return null;
    const index = items.findIndex((item: any) => String(item.id ?? item.conversation_id ?? item.conversationId ?? "") === String(normalized.id));

    if (index >= 0) {
      items[index] = { ...items[index], ...normalized };
    } else {
      items.push(normalized);
    }

    fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf-8");
    return normalized;
  }

  function persistChatMessagePair(source: "desktop" | "mobile", input: {
    conversationId: string;
    title?: string;
    summary?: string;
    activeContext?: Record<string, unknown>;
    taskState?: Record<string, unknown>;
    userId?: string;
    userText: string;
    replyText: string;
  }): any {
    const file = getConversationStoreFile(source);
    let items: any[] = [];
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        items = raw ? JSON.parse(raw) : [];
      }
    } catch {}

    const now = new Date().toISOString();
    const existing = items.find((item: any) => String(item.id ?? item.conversation_id ?? item.conversationId ?? "") === String(input.conversationId));
    const existingMessages: any[] = Array.isArray(existing?.messages) ? existing.messages : [];
    const userMessage = { id: `msg-${Date.now()}-user`, role: "user", text: input.userText, timestamp: now };
    const assistantMessage = { id: `msg-${Date.now()}-assistant`, role: "assistant", text: input.replyText, timestamp: now };

    const hasUserDuplicate = existingMessages.some((message: any) => message.role === "user" && String(message.text || message.content || "") === String(input.userText) && Math.abs(new Date(message.timestamp || now).getTime() - new Date(now).getTime()) < 5000);
    const hasAssistantDuplicate = existingMessages.some((message: any) => message.role === "assistant" && String(message.text || message.content || "") === String(input.replyText) && Math.abs(new Date(message.timestamp || now).getTime() - new Date(now).getTime()) < 5000);

    const nextMessages = [...existingMessages];
    if (!hasUserDuplicate) nextMessages.push(userMessage);
    if (!hasAssistantDuplicate) nextMessages.push(assistantMessage);

    const nextConversation = normalizeConversationFileItem({
      ...existing,
      id: input.conversationId,
      conversation_id: input.conversationId,
      title: existing?.title || input.title || "Conversation",
      summary: input.summary || existing?.summary || "Continuing a previous conversation.",
      activeContext: { ...(existing?.activeContext || existing?.active_context || {}), ...(input.activeContext || {}) },
      taskState: { ...(existing?.taskState || existing?.task_state || {}), ...(input.taskState || {}), lastUpdatedAt: now },
      userId: input.userId || existing?.userId || existing?.user_id || "default-user",
      updatedAt: now,
      createdAt: existing?.createdAt || existing?.created_at || now,
      messages: nextMessages,
    });

    const index = items.findIndex((item: any) => String(item.id ?? item.conversation_id ?? item.conversationId ?? "") === String(input.conversationId));
    if (index >= 0) items[index] = nextConversation; else items.push(nextConversation);
    fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf-8");
    return nextConversation;
  }

  app.post("/api/chat", async (req, res) => {
    try {
      const text = String(req.body?.text ?? "").trim();
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const source = req.body?.source === "mobile" ? "mobile" : "desktop";
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
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

      const conversationId = String(req.body?.conversationId || "").trim();
      const summary = req.body?.summary ? String(req.body.summary) : "";
      const activeContext = (req.body?.activeContext && typeof req.body.activeContext === "object") ? req.body.activeContext : {};
      const taskState = (req.body?.taskState && typeof req.body.taskState === "object") ? req.body.taskState : {};
      const singerIntent = singerAgent.analyze(text);
      if (["STOP_SINGING", "PAUSE_SINGING", "RESUME_SINGING"].includes(singerIntent.intent)) {
        broadcastToClients({ type: "singer:control", action: singerIntent.intent.replace("_SINGING", ""), conversationId });
        return res.json({ text: singerIntent.intent === "STOP_SINGING" ? "I’ve stopped singing." : singerIntent.intent === "PAUSE_SINGING" ? "I’ve paused the song." : "I’m continuing the song." });
      }
      if (["SING_ORIGINAL", "SING_USER_LYRICS", "SING_PUBLIC_DOMAIN", "GENERATE_SONG"].includes(singerIntent.intent)) {
        const singerTask = singerAgent.submit({ request: text, lyrics: req.body?.lyrics ? String(req.body.lyrics) : undefined, userId: String(req.body?.userId || "default-user"), conversationId: conversationId || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
        return res.status(202).json({ text: "I’m preparing an original SARA song for you.", singerTask });
      }
      const userProfile = userIdentityManager.get(String(req.body?.userId || "default-user"));
      const relevantMemories = await searchMemories(text, source, 10);
      const reply = await generateSaraChatResponse(apiKey, normalizedHistory, text, source, relevantMemories, {
        summary,
        activeContext,
        taskState,
        userProfile: userProfile || undefined,
      });

      const persisted = persistChatMessagePair(source, {
        conversationId: conversationId || `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        title: String(req.body?.title || "Conversation"),
        summary,
        activeContext,
        taskState,
        userId: userProfile?.userId || "default-user",
        userText: text,
        replyText: reply,
      });

      if (persisted) {
        try {
          const file = getConversationStoreFile(source);
          const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : [];
          const existing = items.find((item: any) => String(item.id ?? item.conversation_id ?? item.conversationId ?? "") === String(persisted.id));
          if (existing) {
            existing.summary = summary || existing.summary || "Continuing a previous conversation.";
            existing.activeContext = { ...(existing.activeContext || existing.active_context || {}), ...(activeContext || {}) };
            existing.taskState = { ...(existing.taskState || existing.task_state || {}), ...(taskState || {}), lastUpdatedAt: new Date().toISOString() };
            existing.updatedAt = existing.updatedAt || new Date().toISOString();
            fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf-8");
          }
        } catch {}
      }

      await processConversationSlice(apiKey, [...normalizedHistory, { role: "user", text }, { role: "assistant", text: reply }], source);
      res.json({ ok: true, text: reply, conversationId: persisted?.id || conversationId || null, userId: persisted?.userId || userProfile?.userId || "default-user" });
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
    const key = String(req.body?.apiKey ?? "").trim();
    if (!key) return res.status(400).json({ ok: false, error: "API key is required." });
    if (key.length > 512 || /[\r\n\u0000]/.test(key)) {
      return res.status(400).json({ ok: false, error: "API key format is invalid." });
    }

    try {
      const testClient = new GoogleGenAI({ apiKey: key });
      const models = await testClient.models.list();
      await models[Symbol.asyncIterator]().next();
      setGeminiApiKey(key);
      return res.json({ ok: true, hasApiKey: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      const isRejectedKey = /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|\b401\b|\b403\b/i.test(message);
      // Provider errors may echo credentials or request URLs; log only the category.
      logError(isRejectedKey ? "APIKEY_SAVE_REJECTED" : "APIKEY_SAVE_VERIFY_FAILED");
      if (isRejectedKey) {
        return res.status(400).json({ ok: false, error: "Google rejected that API key. Check it and try again." });
      }
      return res.status(502).json({ ok: false, error: "Could not verify the API key with Google. Check the network and try again." });
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

  // Browser-facing status stays same-origin in the UI; the backend performs the
  // loopback call so previews and remote browsers never target their own localhost.
  app.get("/api/browser-automation/status", async (_req, res) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const response = await fetch("http://127.0.0.1:3001/api/status", { signal: ctrl.signal, redirect: "error" });
      if (!response.ok) return res.status(503).json({ online: false, logs: [] });
      const payload = await response.json() as { logs?: unknown[] };
      const logs = Array.isArray(payload.logs) ? payload.logs.slice(-100).map((item, index) => {
        const log = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const type = ["info", "success", "error", "action"].includes(String(log.type)) ? String(log.type) : "info";
        return { id: String(log.id ?? index), text: String(log.text ?? log.message ?? item ?? ""), type };
      }) : [];
      return res.json({ online: true, logs });
    } catch {
      return res.json({ online: false, logs: [] });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post("/api/vision/enable", async (_req, res) => {
    try {
      const result = await callDesktopAgent("gestureControlStart", {});
      if (result.ok) return res.json(result);
      const fallback = await callDesktopAgent("enableVision", {});
      return res.status(fallback.ok ? 200 : 502).json(fallback);
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || "Could not enable vision." });
    }
  });

  app.post("/api/vision/disable", async (_req, res) => {
    try {
      const result = await callDesktopAgent("gestureControlStop", {});
      if (result.ok) return res.json(result);
      const fallback = await callDesktopAgent("disableVision", {});
      return res.status(fallback.ok ? 200 : 502).json(fallback);
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || "Could not disable vision." });
    }
  });

  app.get("/api/vision/state", async (_req, res) => {
    try {
      const result = await callDesktopAgent("getVisionState", {});
      return res.status(result.ok ? 200 : 502).json(result);
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || "Could not read vision state." });
    }
  });

  app.post("/api/vision/analyze", async (req, res) => {
    try {
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      const validSignature = mime === "image/jpeg"
        ? body?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        : mime === "image/png"
          ? body?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : mime === "image/webp"
            ? body?.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP"
            : false;
      if (!body?.length || !validSignature) {
        return res.status(400).json({ ok: false, error: "Upload a valid JPEG, PNG, or WebP camera frame." });
      }

      const question = String(req.headers["x-sara-question"] || "Describe visible, non-sensitive details.")
        .replace(/[\r\n\u0000]/g, " ")
        .trim()
        .slice(0, 500) || "Describe visible, non-sensitive details.";
      const apiKey = getGeminiApiKey();
      if (!apiKey) return res.status(503).json({ ok: false, error: "Gemini API key is not configured." });

      const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: body.toString("base64") } },
            { text: `Analyze this camera frame for the user's request: ${question}\nOnly report observable, non-sensitive details.` },
          ],
        }],
        config: { maxOutputTokens: 256, temperature: 0.3 },
      });
      return res.json({ ok: true, text: String(response.text || "").trim() });
    } catch (error: any) {
      logError(`VISION_ANALYSIS_FAILED: ${String(error?.message || error)}`);
      return res.status(502).json({ ok: false, error: "Camera-frame analysis failed." });
    }
  });

  app.post("/api/vision/screen-capture", async (_req, res) => {
    try {
      const result = await callDesktopAgent("takeScreenshot", {
        include_image: true,
        max_dim: 960,
      });
      const capture = (result as any)?.result ?? result;
      if (!capture?.image_base64 || !capture?.image_mime) {
        return res.status(503).json({ ok: false, error: "Desktop screen capture is unavailable." });
      }
      return res.json({
        ok: true,
        imageBase64: capture.image_base64,
        imageMime: capture.image_mime,
        width: capture.width,
        height: capture.height,
      });
    } catch (error: any) {
      return res.status(503).json({ ok: false, error: error?.message || "Desktop screen capture failed." });
    }
  });

  // Admin: fetch recent audit events (DB-backed if available)
  app.get("/api/admin/audit", async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? "") as string);
      if (!isAdminAuthValid(_req, adminToken, provided)) return res.status(401).json({ ok: false, error: "Unauthorized" });

      const auditLogger = new AuditLogger(path.join(DATA_DIR, "security"));
      const events = await auditLogger.readAll();
      res.json({ ok: true, count: events.length, events });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // The integrity monitor is intentionally disabled in the active backend.
  // Keep these admin-only responses explicit so the dashboard cannot imply a
  // trusted baseline when no verification has actually been performed.
  app.get('/api/admin/security/status', (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    return res.json({
      ok: true,
      enabled: false,
      status: 'DISABLED',
      message: 'Integrity baseline verification is not enabled in this backend.',
    });
  });

  app.post('/api/admin/security/verify', (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    return res.status(501).json({ ok: false, enabled: false, error: 'Integrity verification is disabled in this backend.' });
  });

  app.post('/api/admin/security/approveBaseline', (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    return res.status(501).json({ ok: false, enabled: false, error: 'Integrity baseline approval is disabled in this backend.' });
  });

  app.get('/api/admin/audit/recent', async (_req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((_req.headers['x-admin-token'] ?? _req.headers['x-admin-key'] ?? "") as string);
      if (!isAdminAuthValid(_req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(_req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

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
        securityEventsCount: auditEvents.filter(e => e.severity === 'WARNING' || e.severity === 'HIGH' || e.severity === 'CRITICAL').length,
        securityStatus: { enabled: false, status: 'DISABLED' },
      });
    } catch (e: any) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // SARA Self Shutdown endpoint — destructive service control requires admin auth.
  app.post('/api/system/shutdown', async (_req, res) => {
    if (!checkAdminAuth(_req, res)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(_req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(_req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const cfg = settings.notifications || {};
      // mask secrets when returning
      const masked: Record<string, any> = { ...cfg };
      if (masked.webhook) masked.webhook = { url: masked.webhook.url, events: masked.webhook.events || ['*'], secret_mask: masked.webhook.secret ? '*****' : '' };
      res.json({ ok: true, config: masked });
    } catch (e:any) { res.status(500).json({ ok:false, error: String(e) }); }
  });

  app.post('/api/admin/notifications', async (req, res) => {
    try {
      const settings = loadSettingsFile();
      const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings['adminToken'] ?? "");
      const provided = String((req.headers['x-admin-token'] ?? req.headers['x-admin-key'] ?? "") as string);
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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
      if (!isAdminAuthValid(req, adminToken, provided)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
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

  app.get("/api/calendar/events", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      return res.json({ ok: true, events: localCalendarService.list({ from, to }) });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Invalid calendar range." });
    }
  });

  app.post("/api/calendar/events", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const event = localCalendarService.create(req.body || {});
      return res.status(201).json({ ok: true, event });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Invalid calendar event." });
    }
  });

  app.delete("/api/calendar/events/:id", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const deleted = localCalendarService.delete(req.params.id);
    return deleted
      ? res.json({ ok: true })
      : res.status(404).json({ ok: false, error: "Calendar event not found." });
  });

  app.get("/api/calendar/export.ics", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="sara-calendar.ics"');
    res.type("text/calendar; charset=utf-8").send(localCalendarService.toIcs());
  });

  // General project/task tracking is stored locally in general-projects.json and
  // remains separate from the music studio's project/workflow tables.
  app.get("/api/projects", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, projects: generalProjectManager.listProjects({ includeArchived: req.query.includeArchived === "true" }) });
  });

  app.post("/api/projects", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const project = generalProjectManager.createProject(req.body || {});
      return res.status(201).json({ ok: true, project });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not create project." });
    }
  });

  app.get("/api/projects/:projectId", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const detail = generalProjectManager.getProject(req.params.projectId);
    return detail ? res.json({ ok: true, ...detail }) : res.status(404).json({ ok: false, error: "Project not found." });
  });

  app.patch("/api/projects/:projectId", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const project = generalProjectManager.updateProject(req.params.projectId, req.body || {});
      return project ? res.json({ ok: true, project }) : res.status(404).json({ ok: false, error: "Project not found." });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not update project." });
    }
  });

  app.post("/api/projects/:projectId/tasks", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const task = generalProjectManager.createTask({ ...(req.body || {}), projectId: req.params.projectId });
      return res.status(201).json({ ok: true, task });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not create task." });
    }
  });

  app.patch("/api/project-tasks/:taskId", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const task = generalProjectManager.updateTask(req.params.taskId, req.body || {});
      return task ? res.json({ ok: true, task }) : res.status(404).json({ ok: false, error: "Task not found." });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Could not update task." });
    }
  });

  app.get("/api/tools/metadata", (_req, res) => {
    res.json({ ok: true, version: "1", tools: desktopToolRouter.registry.listMetadata() });
  });

  app.get("/api/identity/profiles", (_req, res) => {
    return res.json({ ok: true, profiles: userIdentityManager.list() });
  });

  app.get("/api/identity/profiles/:userId", (req, res) => {
    const profile = userIdentityManager.get(String(req.params.userId));
    return profile ? res.json({ ok: true, profile }) : res.status(404).json({ ok: false, error: "Profile not found." });
  });

  app.put("/api/identity/profiles/:userId", (req, res) => {
    try {
      const profile = userIdentityManager.upsert({
        ...(req.body || {}),
        userId: String(req.params.userId),
        displayName: String(req.body?.displayName || ""),
      });
      return res.json({ ok: true, profile });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Invalid profile." });
    }
  });

  app.get("/api/integrations/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const providers = apiRegistry.getAllProviders().map((provider) => {
      const metrics = apiHealthMonitor.getMetrics(provider.id);
      const credentialConfigured = !provider.authentication.required || apiCredentialManager.hasCredential(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        category: provider.category,
        capabilities: provider.capabilities,
        enabled: provider.enabled,
        configurationStatus: provider.status,
        credentialRequired: provider.authentication.required,
        credentialConfigured,
        ready: provider.enabled && provider.status === "active" && credentialConfigured,
        healthCheck: metrics ? {
          successRate: metrics.successRate,
          averageLatencyMs: metrics.averageLatency,
          totalRequests: metrics.totalRequests,
          failures: metrics.failures,
          state: metrics.health,
        } : { state: "not_checked" },
      };
    });
    return res.json({ ok: true, providers });
  });

  app.get("/api/public-apis", (req, res) => {
    const intent = typeof req.query.intent === "string" ? req.query.intent.trim() : "";
    const capability = typeof req.query.capability === "string" ? req.query.capability.trim() : "";
    const requestedLimit = Number(req.query.limit ?? 3);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 10) : 3;
    const knownTools = desktopToolRouter.registry.list().map((tool) => tool.name);

    if (!intent && !capability) {
      return res.json({ ok: true, version: "1", count: publicApiCatalogManager.getAll().length, apis: publicApiCatalogManager.getAll() });
    }

    const candidates = publicApiCatalogManager.searchCandidates(intent || capability, {
      limit,
      knownTools,
      authorized: req.query.authorized === "true",
      confirmed: req.query.confirmed === "true",
    });
    return res.json({ ok: true, version: "1", intent: intent || capability, count: candidates.length, candidates });
  });

  app.post("/api/public-apis/import", (req, res) => {
    const settings = loadSettingsFile();
    const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings["adminToken"] ?? "");
    const provided = String((req.headers["x-admin-token"] ?? req.headers["x-admin-key"] ?? "") as string);
    if (!isAdminAuthValid(req, adminToken, provided)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) {
      return res.status(400).json({ ok: false, error: "entries must contain between 1 and 100 catalog entries." });
    }

    try {
      const imported = publicApiCatalogManager.importEntries(entries, { persist: true });
      return res.json({ ok: true, version: "1", imported: imported.length, apis: imported });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Catalog import failed." });
    }
  });

  app.post("/api/public-apis/refresh", async (req, res) => {
    const settings = loadSettingsFile();
    const adminToken = process.env.SARA_ADMIN_TOKEN || String(settings["adminToken"] ?? "");
    const provided = String((req.headers["x-admin-token"] ?? req.headers["x-admin-key"] ?? "") as string);
    if (!isAdminAuthValid(req, adminToken, provided)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    try {
      const requestedLimit = Number(req.body?.maxEntries ?? 100);
      const maxEntries = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500) : 100;
      const summary = await publicApiCatalogManager.refreshFromPublicApis({ maxEntries });
      return res.json({ ok: true, version: "1", summary });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || "Catalog refresh failed." });
    }
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

  app.post("/api/music/projects", async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || req.body?.theme || "").trim();
      const conversationId = String(req.body?.conversationId || "").trim() || undefined;
      const userId = String(req.body?.userId || "default-user");
      if (!prompt) return res.status(400).json({ ok: false, error: "prompt or theme is required." });
      const created = await autonomousMusicCreator.create({ userId, conversationId, prompt, brief: req.body?.brief });
      const task = await createTask({
        conversationId: conversationId || `music-${created.project.project_id}`,
        description: `Autonomous music workflow: ${created.project.project_id}`,
        priority: Number(req.body?.priority ?? 5),
        assignedAgent: "music_creator_agent",
        metadata: { musicWorkflowTaskId: created.workflow.taskId, projectId: created.project.project_id },
      });
      try { const { getTaskRunner } = await import("./server_task_manager"); await getTaskRunner()?.wake(); } catch {}
      return res.status(202).json({ ok: true, project: created.project, workflow: created.workflow, task });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || "Failed to create music project." });
    }
  });

  app.get("/api/music/projects", async (req, res) => {
    const projects = await new MusicProjectManager().listProjects(String(req.query.userId || "default-user"));
    return res.json({ ok: true, projects });
  });

  app.get("/api/music/projects/:projectId", async (req, res) => {
    const manager = new MusicProjectManager();
    const project = await manager.getProject(String(req.params.projectId || ""));
    if (!project) return res.status(404).json({ ok: false, error: "Music project not found." });
    return res.json({ ok: true, project, workflow: await autonomousMusicCreator.getByProject(project.project_id) });
  });

  app.get("/api/music/providers/health", async (_req, res) => res.json({ ok: true, providers: await musicProviderRegistry.health() }));

  app.post("/api/music/projects/:projectId/prepare-publishing", async (req, res) => {
    try {
      const readiness = await musicContentPreparation.prepare(String(req.params.projectId || ""));
      return res.json({ ok: true, readiness });
    } catch (error: any) {
      return res.status(404).json({ ok: false, error: error?.message || "Could not prepare publishing metadata." });
    }
  });

  app.post("/api/music/projects/:projectId/approve-publishing", async (req, res) => {
    try {
      const approvedBy = String(req.body?.approvedBy || req.body?.userId || "default-user").trim();
      const readiness = await musicContentPreparation.approve(String(req.params.projectId || ""), approvedBy);
      return res.json({ ok: true, readiness });
    } catch (error: any) {
      return res.status(404).json({ ok: false, error: error?.message || "Could not approve publishing." });
    }
  });

  // WhatsApp is externally visible: every task starts behind the admin approval gate.
  app.post("/api/tasks/whatsapp", async (req, res) => {
    try {
      const body = req.body || {};
      const conversationId = String(body.conversationId || "").trim();
      if (!conversationId || !body.message || !body.phone) {
        return res.status(400).json({ error: "Missing conversationId, phone, or message" });
      }

      const whatsapp = await import('./src/whatsapp_client');
      let phone: string;
      let message: string;
      try {
        phone = whatsapp.normalizeWhatsAppRecipient(body.phone);
        message = whatsapp.validateWhatsAppText(body.message);
      } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Invalid WhatsApp recipient or message." });
      }
      const use_companion = body.use_companion;
      const args = { phone, message, use_companion };
      const task = await createTask({
        conversationId,
        description: `WhatsApp: send to +${phone}`,
        priority: 5,
        assignedAgent: "whatsapp_agent",
        status: "awaiting_confirmation",
        metadata: { tool: "whatsapp_send", args },
      });

      try {
        await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId, toolName: "whatsapp_send", args, taskId: task.taskId, timestamp: new Date().toISOString() });
      } catch {}

      let confirmation: { id: string; action: string; taskId: string | null; expiresAt: number };
      try {
        confirmation = await createPendingConfirmation("whatsapp_send", args, 300, task.taskId);
      } catch (error: any) {
        await updateTask(task.taskId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: error?.message || "Could not create the required WhatsApp approval.",
        });
        throw error;
      }
      const approvedTask = await updateTask(task.taskId, {
        status: "awaiting_confirmation",
        metadata: { ...(task.metadata || {}), confirmationId: confirmation.id },
      });
      return res.json({ ok: true, task: approvedTask || task, confirmation });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to create WhatsApp approval." });
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
        const confirmation = await createPendingConfirmation(toolName, args, 300, task.taskId);
        await updateTask(task.taskId, { status: "awaiting_confirmation", metadata: { confirmationId: confirmation.id } });
        return res.json({ ok: true, task, confirmation });
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
      const name = String(req.body?.name ?? "").trim().slice(0, 120) || `device-${Date.now()}`;
      const id = crypto.randomBytes(8).toString("hex");
      const token = crypto.randomBytes(32).toString("base64url");

      // The Python companion manager is the sole registry writer; both services
      // share DATA_DIR/companions.json and store the same salted scrypt format.
      const agentResult = await callCompanionEndpoint("/companion/pair", { device_id: id, name, token });
      if (!agentResult.ok) {
        return res.status(502).json({ ok: false, error: agentResult.error || "Desktop companion service is unavailable." });
      }
      const agentPayload = agentResult.result as any;
      const pairedDevice = agentPayload?.result;
      if (agentPayload?.ok !== true || pairedDevice?.id !== id) {
        return res.status(502).json({ ok: false, error: "Desktop companion service did not confirm the new pairing." });
      }
      const storedRecord = loadCompanionRecords().find((record) => record.id === id);
      if (!storedRecord || !verifyCompanionToken(storedRecord, token)) {
        return res.status(502).json({ ok: false, error: "Companion registry is not shared with the desktop agent; pairing was refused." });
      }
      return res.json({ ok: true, result: { id, name, token } });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message || "Failed to pair companion." });
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
    try {
      const parsed = fs.existsSync(CONFIRMATIONS_FILE) ? JSON.parse(fs.readFileSync(CONFIRMATIONS_FILE, "utf-8")) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function saveConfirmations(list: any[]): Promise<void> {
    const temporary = `${CONFIRMATIONS_FILE}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(CONFIRMATIONS_FILE), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(list, null, 2), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temporary, CONFIRMATIONS_FILE);
      try { fs.chmodSync(CONFIRMATIONS_FILE, 0o600); } catch {}
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
  }

  async function createPendingConfirmation(
    action: string,
    args: Record<string, unknown>,
    ttlSeconds = 300,
    taskId?: string,
  ): Promise<{ id: string; action: string; taskId: string | null; expiresAt: number }> {
    const allowedActions = new Set(["whatsapp_send", "youtube_search", "youtube_play"]);
    if (!allowedActions.has(action) || !args || typeof args !== "object") {
      throw new Error("This action cannot enter the pending-confirmation workflow.");
    }
    const now = Date.now();
    const requestedTtl = Number(ttlSeconds);
    const boundedTtl = Math.max(30, Math.min(600, Number.isFinite(requestedTtl) ? requestedTtl : 300));
    const list = (await loadConfirmations()).filter((entry: any) =>
      entry?.approvalMode === "admin-ui" && entry?.status === "pending" && Number(entry.expiresAt) > now,
    );
    if (list.length >= 100) throw new Error("Too many pending confirmations; resolve existing items first.");

    const entry = {
      id: crypto.randomBytes(16).toString("hex"),
      approvalMode: "admin-ui",
      status: "pending",
      action,
      args: JSON.parse(JSON.stringify(args)),
      taskId: taskId || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + boundedTtl * 1000,
    };
    list.push(entry);
    await saveConfirmations(list);
    return { id: entry.id, action: entry.action, taskId: entry.taskId, expiresAt: entry.expiresAt };
  }

  app.get("/api/confirm/list", async (req, res) => {
    try {
      if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Unauthorized" });
      const now = Date.now();
      const all = await loadConfirmations();
      const pending = all.filter((confirmation: any) =>
        confirmation?.approvalMode === "admin-ui" && confirmation?.status === "pending" && Number(confirmation.expiresAt) > now,
      );
      if (pending.length !== all.length) await saveConfirmations(pending);
      const safe = pending.map((confirmation: any) => ({
        id: confirmation.id,
        action: confirmation.action,
        args: redactSecrets(confirmation.args || {}),
        taskId: confirmation.taskId || null,
        createdAt: confirmation.createdAt,
        expiresAt: confirmation.expiresAt,
      }));
      return res.json({ ok: true, confirmations: safe });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Could not load confirmations." });
    }
  });

  app.post("/api/confirm/verify", async (req, res) => {
    try {
      if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: "Unauthorized" });
      const id = String(req.body?.id || "");
      const approved = req.body?.approved;
      if (!/^[a-f0-9]{32}$/i.test(id) || typeof approved !== "boolean") {
        return res.status(400).json({ ok: false, error: "A confirmation ID and explicit approval decision are required." });
      }
      const list = await loadConfirmations();
      const idx = list.findIndex((confirmation: any) =>
        confirmation?.id === id && confirmation?.approvalMode === "admin-ui" && confirmation?.status === "pending",
      );
      if (idx < 0) return res.status(404).json({ ok: false, error: "Pending confirmation not found." });
      const entry = list[idx];
      if (Date.now() > Number(entry.expiresAt || 0)) {
        list.splice(idx, 1);
        await saveConfirmations(list);
        return res.status(410).json({ ok: false, error: "Confirmation expired." });
      }

      // Consume before any dispatch to prevent replay if the agent call fails.
      list.splice(idx, 1);
      await saveConfirmations(list);
      if (!approved) {
        if (entry.taskId) {
          await updateTask(entry.taskId, {
            status: "cancelled",
            completedAt: new Date().toISOString(),
            error: "User rejected the pending action.",
          });
        }
        return res.json({ ok: true, approved: false });
      }

      const allowedActions = new Set(["whatsapp_send", "youtube_search", "youtube_play"]);
      if (!allowedActions.has(String(entry.action))) {
        return res.status(400).json({ ok: false, error: "The pending action is not permitted." });
      }
      let execResult: any;
      try {
        if (String(entry.action) === "whatsapp_send") {
          const to = whatsappClient.normalizeWhatsAppRecipient(entry.args?.phone ?? entry.args?.to);
          const text = whatsappClient.validateWhatsAppText(entry.args?.message ?? entry.args?.text);
          const result = await whatsappClient.sendTextMessage(to, text, String(entry.taskId || entry.id));
          execResult = { ok: true, result };
        } else {
          execResult = await callDesktopAgent(String(entry.action), entry.args || {});
        }
      } catch (error: any) {
        execResult = { ok: false, error: error?.message || String(error), uncertain: error?.uncertain === true };
      }
      if (entry.taskId) {
        const uncertain = execResult.uncertain === true;
        await updateTask(entry.taskId, {
          status: uncertain ? "paused" : execResult.ok ? "completed" : "failed",
          completedAt: uncertain ? undefined : new Date().toISOString(),
          result: execResult.ok ? JSON.stringify(execResult.result ?? execResult) : undefined,
          error: execResult.ok ? undefined : execResult.error || JSON.stringify(execResult),
        });
      }
      return res.json({ ok: true, approved: true, execResult });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || "Failed to process confirmation." });
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
      const body = req.body || {};
      const whatsapp = await import('./src/whatsapp_client');
      let to: string;
      let text: string;
      try {
        to = whatsapp.normalizeWhatsAppRecipient(body.to ?? body.phone);
        text = whatsapp.validateWhatsAppText(body.text ?? body.message);
      } catch (error: any) {
        return res.status(400).json({ ok: false, error: error?.message || 'Invalid WhatsApp recipient or message.' });
      }

      if (body.confirmed !== true) {
        return res.status(428).json({
          ok: false,
          code: 'WHATSAPP_CONFIRMATION_REQUIRED',
          error: 'Confirm the recipient and exact message before sending.',
          confirmation: { recipient: `+${to}`, message: text },
        });
      }

      const convId = String(body.conversationId || (await getOrCreateConversation()).id);
      const task = await createTask({
        conversationId: convId,
        description: `WhatsApp send to +${to}`,
        assignedAgent: 'whatsapp_agent',
        status: 'running',
        metadata: { tool: 'whatsappSend', args: { to, text }, userConfirmedAt: new Date().toISOString() },
      });
      try {
        await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: convId, toolName: 'whatsappSend', args: { to, text }, taskId: task.taskId, timestamp: new Date().toISOString() });
      } catch {}

      try {
        const result = await whatsapp.sendTextMessage(to, text, task.taskId);
        await updateTask(task.taskId, { status: 'completed', completedAt: new Date().toISOString(), result: JSON.stringify(result) });
        return res.json({ ok: true, taskId: task.taskId, result });
      } catch (error: any) {
        const uncertain = error?.uncertain === true;
        await updateTask(task.taskId, {
          status: uncertain ? 'paused' : 'failed',
          updatedAt: new Date().toISOString(),
          completedAt: uncertain ? undefined : new Date().toISOString(),
          error: error?.message || String(error),
        });
        return res.status(502).json({
          ok: false,
          taskId: task.taskId,
          error: error?.message || String(error),
          retryable: false,
          manualReviewRequired: uncertain,
        });
      }
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  // Fetch persisted WhatsApp message history (local file storage)
  app.get('/api/whatsapp/history', async (_req, res) => {
    try {
      const whatsapp = await import('./src/whatsapp_client');
      const list = await Promise.resolve((whatsapp as any).loadMessages ? (whatsapp as any).loadMessages() : []);
      res.json({ ok: true, messages: list });
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

  // Narrow gesture configuration routes; do not restore the legacy arbitrary-tool dispatcher.
  app.get('/api/gesture/config', async (_req, res) => {
    try {
      const result = await callDesktopAgent('gestureControlGetConfig', {});
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Gesture configuration is unavailable in the Desktop Agent.' });
      return res.json({ ok: true, config: result.result });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || 'Gesture configuration is unavailable in the Desktop Agent.' });
    }
  });

  app.put('/api/gesture/config', async (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: 'Admin authorization is required to change gesture configuration.' });
    let config: Record<string, unknown>;
    try {
      config = sanitizeGestureConfig(req.body?.config);
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || 'Gesture configuration is invalid.' });
    }
    try {
      const result = await callDesktopAgent('gestureControlSetConfig', { config });
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Gesture configuration could not be applied.' });
      return res.json({ ok: true, config });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || 'Gesture configuration could not be applied.' });
    }
  });

  app.post('/api/gesture/mappings/get', async (_req, res) => {
    try {
      const result = await callDesktopAgent('gestureControlGetMappings', {});
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Gesture mappings are unavailable in the Desktop Agent.' });
      return res.json({ ok: true, mappings: result.result });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || 'Gesture mappings are unavailable in the Desktop Agent.' });
    }
  });

  app.post('/api/gesture/mappings/set', async (req, res) => {
    if (!checkAdminAuth(req, res)) return res.status(401).json({ ok: false, error: 'Admin authorization is required to change gesture mappings.' });
    const mappings = req.body?.mappings;
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
      return res.status(400).json({ ok: false, error: 'mappings must be a JSON object.' });
    }
    try {
      const result = await callDesktopAgent('gestureControlSetMappings', { mappings });
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Gesture mappings could not be applied.' });
      return res.json({ ok: true });
    } catch (error: any) {
      return res.status(502).json({ ok: false, error: error?.message || 'Gesture mappings could not be applied.' });
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

      const toolName = String(last.toolName).replace(/_retry$/, "");
      const args = last.args || {};
      const confirmDangerousRetry = req.body?.confirmDangerousRetry === true;
      const retryPolicy = evaluateRetryPolicy(toolName, confirmDangerousRetry);

      if (!retryPolicy.allowed) {
        return res.status(409).json({
          ok: false,
          code: "RETRY_CONFIRMATION_REQUIRED",
          error: retryPolicy.reason,
          tool: toolName,
          requiresConfirmation: true,
        });
      }
      await updateTask(task.taskId, {
        status: "retrying",
        retryCount: (task.retryCount || 0) + 1,
        startedAt: new Date().toISOString(),
      });
      const isWhatsAppTool = /^whatsapp(?:send|_send|_reply|reply|_group_send|_send_media)$/i.test(String(toolName));
      const retryArgs = isWhatsAppTool && confirmDangerousRetry
        ? { ...args, taskId: task.taskId, confirmed: true, clientMessageId: `${task.taskId}:retry:${(task.retryCount || 0) + 1}` }
        : args;
      const agentResult = await callDesktopAgent(toolName, retryArgs);

      // Record the exact retry arguments for auditability and future duplicate protection.
      await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId: task.conversationId, toolName: `${toolName}_retry`, args: retryArgs, result: agentResult.result, error: agentResult.error, taskId: task.taskId, timestamp: new Date().toISOString() });

      // A successful provider acknowledgement is the available verification for a Cloud API send.
      const verified = isWhatsAppTool && agentResult.ok;

      await updateTask(task.taskId, {
        status: agentResult.ok && (!isWhatsAppTool || verified) ? "completed" : "failed",
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
      const found = authenticateCompanionRequest(req);
      if (!found) return res.status(401).json({ ok: false, error: "Invalid companion credentials." });
      return res.json({ ok: true, result: { id: found.id, name: found.name } });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || "Companion authentication failed." });
    }
  });

  app.post("/api/companion/command", async (req, res) => {
    try {
      if (!authenticateCompanionRequest(req)) {
        return res.status(401).json({ ok: false, error: "Invalid companion credentials." });
      }

      // The Python service independently checks the same paired credentials.
      const agentResult = await callCompanionEndpoint("/companion/command", req.body || {});
      if (!agentResult.ok) {
        return res.status(agentResult.status).json({ ok: false, error: agentResult.error });
      }
      return res.json(agentResult.result);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || "Companion command failed." });
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

  // Mobile images are private runtime data, not public frontend assets.
  app.post("/api/mobile/upload-image", async (req, res) => {
    try {
      const { data, mime, device_id, token } = req.body || {};
      if (!authenticateCompanion(String(device_id || ""), String(token || ""))) {
        return res.status(401).json({ error: "Invalid companion credentials for upload." });
      }

      let decoded;
      try {
        decoded = decodeMobileImage(data, mime);
      } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Upload a valid JPEG, PNG, or WebP image." });
      }
      const image = storeMobileImage(DATA_DIR, decoded);
      return res.status(201).json({ ok: true, ...image });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to save image." });
    }
  });

  // Camera media API. These routes are part of the production backend because
  // the active Electron renderer uses them for explicit save/gallery actions.
  app.post("/api/camera/photo", async (req, res) => {
    try {
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      const validJpeg = mime === "image/jpeg" && body?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
      const validPng = mime === "image/png" && body?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!body?.length || (!validJpeg && !validPng)) {
        return res.status(400).json({ error: "Upload a valid JPEG or PNG image as the raw request body." });
      }
      const photosDir = path.join(dataFile("SARA_MEDIA"), "photos");
      fs.mkdirSync(photosDir, { recursive: true });
      const extension = validPng ? "png" : "jpg";
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${extension}`;
      const outPath = path.join(photosDir, filename);
      fs.writeFileSync(outPath, body);
      return res.json({ ok: true, path: outPath, filename });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to save photo." });
    }
  });

  app.post("/api/camera/video", async (req, res) => {
    try {
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (
        !body?.length ||
        (mime !== "video/webm" && mime !== "application/octet-stream") ||
        !body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      ) {
        return res.status(400).json({ error: "Upload a valid WebM recording as the raw request body." });
      }
      const videosDir = path.join(dataFile("SARA_MEDIA"), "videos");
      fs.mkdirSync(videosDir, { recursive: true });
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.webm`;
      const outPath = path.join(videosDir, filename);
      fs.writeFileSync(outPath, body);
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
      // Mobile records are private to paired companion devices.
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      if (!fs.existsSync(file)) return res.json([]);
      const raw = fs.readFileSync(file, "utf-8");
      const items = raw ? JSON.parse(raw) : [];
      res.json(items.sort((a: any, b: any) => (a.updatedAt || a.updated_at || 0) < (b.updatedAt || b.updated_at || 0) ? 1 : -1));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/conversations/search", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
      const query = String(req.query.q ?? "").trim().toLowerCase();
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      let items: any[] = [];
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        items = raw ? JSON.parse(raw) : [];
      }
      if (!query) return res.json(items.sort((a: any, b: any) => (a.updatedAt || a.updated_at || 0) < (b.updatedAt || b.updated_at || 0) ? 1 : -1));

      const filtered = items.filter((item) => {
        const preview = (item.messages || []).map((message: any) => String(message.text || message.content || "")).join(" ");
        const haystack = `${item.title || ""} ${preview} ${(item.summary || "")}`.toLowerCase();
        return haystack.includes(query);
      });

      res.json(filtered.sort((a: any, b: any) => (a.updatedAt || a.updated_at || 0) < (b.updatedAt || b.updated_at || 0) ? 1 : -1));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/conversations/:id/restore", async (req, res) => {
    try {
      const source = req.query.source === "mobile" ? "mobile" : "desktop";
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
      }
      const id = String(req.params.id || "");
      const file = dataFile(source === "mobile" ? "conversations_mobile.json" : "conversations.json");
      if (!fs.existsSync(file)) return res.json({ conversation: null, context: null });
      const items = JSON.parse(fs.readFileSync(file, "utf-8"));
      const match = items.find((item: any) => String(item.id || item.conversation_id) === String(id));
      if (!match) return res.json({ conversation: null, context: null });
      const restored = await restoreConversationContextRecord(match);
      const reconstructed = {
        ...match,
        id: match.id || match.conversation_id,
        title: match.title || "Restored conversation",
        updatedAt: match.updatedAt || match.updated_at || new Date().toISOString(),
        summary: match.summary || restored.summary || "Conversation restored.",
        activeContext: match.activeContext || match.active_context || restored.activeContext || {},
        taskState: match.taskState || match.task_state || restored.taskState || {},
        metadata: match.metadata || {},
      };
      res.json({ conversation: reconstructed, context: restored });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/conversations", async (req, res) => {
    try {
      const source = req.body?.source === "mobile" ? "mobile" : "desktop";
      const conversation = req.body?.conversation;
      if (!conversation || !conversation.id) return res.status(400).json({ error: "Conversation body with id is required." });
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
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
      if (source === "mobile" && !authenticateCompanionRequest(req)) {
        return res.status(401).json({ error: "Invalid companion credentials." });
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

      const response = await fetchPublicUrl(url, {
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 10_000,
        maxRedirects: 3,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return res.status(502).json({ error: `Remote page returned HTTP ${response.statusCode}.` });
      }

      const html = response.body.toString("utf8");

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
      console.error("[Proxy Scraper] Remote fetch failed:", err?.message || String(err));
      res.status(502).json({ error: "The remote page could not be fetched safely." });
    }
  });

  // Bounded web preview. Remote HTML is always sandboxed to an opaque origin.
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

      let response;
      try {
        response = await fetchPublicUrl(targetUrl, {
          maxBytes: 8 * 1024 * 1024,
          timeoutMs: 15_000,
          maxRedirects: 3,
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        });
      } catch {
        return res.status(502).send("Sara Web Proxy Error: The remote website could not be fetched safely.");
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return res.status(502).send(`Sara Web Proxy Error: Remote website returned HTTP ${response.statusCode}.`);
      }

      const contentTypeHeader = response.headers["content-type"];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] || "" : contentTypeHeader || "";
      
      // Proxy bounded binary assets without forwarding remote response headers.
      if (!contentType.toLowerCase().includes("text/html")) {
        const safeContentType = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*charset=[\w.+-]+)?$/i.test(contentType)
          ? contentType
          : "application/octet-stream";
        res.setHeader("Content-Type", safeContentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.send(response.body);
      }

      let htmlContents = response.body.toString("utf8");

      targetUrl = response.finalUrl;
      // Inject a bounded base URL after public-DNS validation and redirects.
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

            // Opaque-origin frame bridge. Commands are accepted only from the
            // exact embedding origin and replies expose no parent capabilities.
            var parentOrigin = '';
            try { parentOrigin = new URL(document.referrer).origin; } catch (_) {}
            window.addEventListener('message', async function(event) {
              if (event.source !== window.parent || !parentOrigin || event.origin !== parentOrigin) return;
              var message = event.data;
              if (!message || message.type !== 'SARA_COMMAND' || typeof message.requestId !== 'string') return;
              var payload = message.payload || {};
              var result = { ok: false, error: 'Unsupported browser command.' };
              try {
                if (message.command === 'scroll') {
                  var amount = Math.max(0, Math.min(Number(payload.amount) || 0, 1500));
                  window.scrollBy({ top: payload.direction === 'up' ? -amount : amount, behavior: 'smooth' });
                  result = { ok: true, message: 'Scrolled the page.' };
                } else if (message.command === 'type') {
                  var text = String(payload.text || '').slice(0, 2000);
                  var input = document.querySelector('input[type="text"], input[type="search"], textarea, [contenteditable="true"]');
                  if (!input || !text) throw new Error('No eligible text field was found.');
                  input.focus();
                  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
                    var prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                    if (setter) setter.call(input, text); else input.value = text;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  } else {
                    input.textContent = text;
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                  }
                  result = { ok: true, message: 'Typed text into the page field.' };
                } else if (message.command === 'click') {
                  var selector = String(payload.selector || '').slice(0, 250);
                  var element = null;
                  try { element = selector ? document.querySelector(selector) : null; } catch (_) {}
                  if (!element && selector) {
                    var candidates = Array.from(document.querySelectorAll('a, button, [role="button"], span, h3'));
                    element = candidates.find(function(item) { return (item.textContent || '').toLowerCase().includes(selector.toLowerCase()); }) || null;
                  }
                  if (!element) throw new Error('No matching clickable element was found.');
                  element.click();
                  result = { ok: true, message: 'Clicked the matching page element.' };
                } else if (message.command === 'media') {
                  var video = document.querySelector('video');
                  if (!video) throw new Error('No video element is available on this page.');
                  if (payload.action === 'play') await video.play();
                  else if (payload.action === 'pause') video.pause();
                  else if (payload.action === 'volume') video.volume = Math.max(0, Math.min(Number(payload.value) / 100, 1));
                  else if (payload.action === 'mute') video.muted = true;
                  else if (payload.action === 'unmute') video.muted = false;
                  else if (payload.action === 'skip') video.currentTime += 30;
                  else throw new Error('Unsupported media action.');
                  result = { ok: true, message: 'Applied the media command.' };
                }
              } catch (error) {
                result = { ok: false, error: error && error.message ? String(error.message) : 'Browser command failed.' };
              }
              window.parent.postMessage({ type: 'SARA_RESULT', requestId: message.requestId, ok: result.ok, result: result, error: result.error }, '*');
            });

            // Keep dialogs and new-window navigation inside the browsing portal.
            window.alert = function(msg) { console.log('[SARA Browser alert]', msg); };
            window.confirm = function(msg) { console.log('[SARA Browser confirm]', msg); return false; };
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

      // The CSP sandbox reinforces the iframe's opaque-origin boundary. No
      // upstream framing or policy headers are forwarded to this response.
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Sara-Proxied", "true");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-presentation");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Internal proxy error:", e?.message || String(e));
      res.status(502).send("Sara Web Proxy Error: The requested page could not be rendered.");
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
  
  // Remote binds require end-to-end TLS; loopback remains HTTP for Electron's local UI.
  const remoteBind = !isLoopbackHost(SERVER_HOST);
  const server = remoteBind
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) }, app)
    : http.createServer(app);
  
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

  const singerAgent = new SingerAgent(undefined, undefined, undefined, async (request, language, sections) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error("LYRICS_GENERATOR_UNAVAILABLE: Gemini API key is not configured.");
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Write original song lyrics for SARA in language ${language}. Request: ${request}. Use only these sections: ${sections.join(", ")}. Keep it concise. Do not imitate or reference any real singer or copyrighted song. Return lyrics only with section labels.`,
      config: { maxOutputTokens: 700, temperature: 0.8 },
    });
    const text = String(response.text || "").trim();
    if (!text) throw new Error("LYRICS_GENERATION_EMPTY: Gemini returned no lyrics.");
    return text;
  });
  singerAgent.on((event) => {
    broadcastToClients(event);
    const task = event.task;
    appendLog("commands.log", `[SINGER] task_id=${task.taskId} stage=${task.status} progress=${task.progress}`);
  });

  app.post("/api/singer/intent", (req, res) => {
    const request = String(req.body?.text || req.body?.request || "").trim();
    if (!request) return res.status(400).json({ ok: false, error: "Singer request is required." });
    return res.json({ ok: true, intent: singerAgent.analyze(request) });
  });

  app.post("/api/singer/tasks", (req, res) => {
    const request = String(req.body?.text || req.body?.request || "").trim();
    const conversationId = String(req.body?.conversationId || "").trim();
    if (!request || !conversationId) return res.status(400).json({ ok: false, error: "request and conversationId are required." });
    const intent = singerAgent.analyze(request);
    if (intent.intent === "NONE") return res.status(422).json({ ok: false, error: "Request is not a Singer Mode request.", intent });
    if (!["SING_ORIGINAL", "SING_USER_LYRICS", "SING_PUBLIC_DOMAIN", "GENERATE_SONG"].includes(intent.intent)) return res.status(422).json({ ok: false, error: "This is a Singer Mode control request, not a generation task.", intent });
    const task = singerAgent.submit({ request, lyrics: req.body?.lyrics ? String(req.body.lyrics) : undefined, userId: String(req.body?.userId || "default-user"), conversationId, correlationId: req.body?.correlationId ? String(req.body.correlationId) : undefined });
    return res.status(202).json({ ok: true, task });
  });

  app.get("/api/singer/tasks/:taskId", (req, res) => {
    const task = singerAgent.getTask(String(req.params.taskId || ""));
    return task ? res.json({ ok: true, task }) : res.status(404).json({ ok: false, error: "Singer task not found." });
  });

  app.get("/api/singer/tasks/:taskId/audio", (req, res) => {
    const task = singerAgent.getTask(String(req.params.taskId || ""));
    const audioPath = task?.session.audioPath;
    const cacheRoot = path.resolve(process.cwd(), "data", "singer-cache");
    if (!task || task.status !== "READY" || !audioPath || !path.resolve(audioPath).startsWith(cacheRoot)) return res.status(404).json({ ok: false, error: "Verified singer audio is not ready." });
    return res.sendFile(path.resolve(audioPath));
  });

  app.get("/api/singer/current", (req, res) => {
    const conversationId = String(req.query.conversationId || "").trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: "conversationId is required." });
    return res.json({ ok: true, task: singerAgent.getCurrent(conversationId) || null });
  });

  app.post("/api/singer/tasks/:taskId/cancel", (req, res) => {
    const task = singerAgent.cancel(String(req.params.taskId || ""));
    return task ? res.json({ ok: true, task }) : res.status(404).json({ ok: false, error: "Singer task not found." });
  });

  app.post("/api/singer/control", (req, res) => {
    const action = String(req.body?.action || "").toUpperCase();
    if (!["STOP", "PAUSE", "RESUME", "VOLUME_UP", "VOLUME_DOWN", "NEXT", "CANCEL"].includes(action)) return res.status(400).json({ ok: false, error: "Unsupported singer control." });
    broadcastToClients({ type: "singer:control", action, taskId: req.body?.taskId ? String(req.body.taskId) : undefined });
    return res.json({ ok: true, action });
  });

  // Webhooks: simple registry stored in data/webhooks.json
  const WEBHOOKS_FILE = dataFile('webhooks.json');

  function adminAttemptSource(req: any): string {
    return String(req.socket?.remoteAddress || req.ip || "unknown").slice(0, 128);
  }

  function lockLocalWorkstationForSecurity(): boolean {
    try {
      if (process.platform === "win32") {
        execFileSync("rundll32.exe", ["user32.dll,LockWorkStation"], { stdio: "ignore", timeout: 5000 });
        return true;
      }
      if (process.platform === "linux") {
        execFileSync("loginctl", ["lock-session"], { stdio: "ignore", timeout: 5000 });
        return true;
      }
      return false;
    } catch (error) {
      console.warn("[Security] Automatic workstation lock was unavailable:", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  function recordInvalidAdminAuth(req: any, force = false): void {
    const presentedCredential = String(req.headers?.["x-admin-token"] || req.headers?.["x-admin-key"] || req.headers?.["x-sara-admin-session"] || "");
    if (!force && !presentedCredential) return;
    const source = adminAttemptSource(req);
    const result = adminAuthAbuseTracker.record(source);
    if (!result.warn && !result.shouldLock) return;
    const autoLockEnabled = process.env.SARA_AUTO_LOCK_ON_AUTH_ABUSE === "true";
    const eventType = result.shouldLock ? "ADMIN_AUTH_ABUSE_LOCK_THRESHOLD" : "ADMIN_AUTH_ABUSE_WARNING";
    const message = result.shouldLock
      ? autoLockEnabled ? "Repeated invalid admin authentication; locking the workstation." : "Repeated invalid admin authentication; automatic screen lock is disabled."
      : "Repeated invalid admin authentication attempts detected.";
    const alert = securityAlerts.add({ createdAt: Date.now(), severity: "WARNING", message, attempts: result.attempts });
    void appendAuditEvent({ event_type: eventType, metadata: { attemptsInWindow: result.attempts, message }, severity: "WARNING" }).catch(() => {});
    try { broadcastToClients({ type: "security_alert", ...alert }); } catch {}
    if (result.shouldLock && autoLockEnabled) {
      const locked = lockLocalWorkstationForSecurity();
      void appendAuditEvent({ event_type: locked ? "SECURITY_WORKSTATION_LOCKED" : "SECURITY_WORKSTATION_LOCK_FAILED", metadata: { reason: "admin_auth_abuse" }, severity: locked ? "HIGH" : "WARNING" }).catch(() => {});
    }
  }

  function isAdminAuthValid(req: any, expectedSecret?: string, providedSecret?: string): boolean {
    const expected = String(expectedSecret || process.env.SARA_ADMIN_TOKEN || process.env.SARA_ADMIN_KEY || "");
    const provided = String(providedSecret ?? req.headers["x-admin-token"] ?? req.headers["x-admin-key"] ?? "");
    const staticTokenValid = Boolean(expected && provided && constantTimeStringEqual(expected, provided));
    const passkeySession = String(req.headers["x-sara-admin-session"] || "");
    const passkeyValid = adminPasskeyManager.isValidSession(passkeySession);
    if (staticTokenValid || passkeyValid) {
      adminAuthAbuseTracker.clear(adminAttemptSource(req));
      return true;
    }
    recordInvalidAdminAuth(req, Boolean(provided || passkeySession));
    return false;
  }

  // A configured admin token remains available for bootstrap/recovery. Once a
  // passkey is enrolled, its short-lived platform-verified session is accepted
  // by the same admin routes.
  function checkAdminAuth(req: any, _res: any) {
    try {
      const settings = loadSettingsFile();
      const expected = process.env.SARA_ADMIN_TOKEN || process.env.SARA_ADMIN_KEY || String(settings["adminToken"] ?? "");
      return isAdminAuthValid(req, expected);
    } catch {
      return isAdminAuthValid(req);
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
    let pathname = "";
    try {
      pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    const hostHeader = String(request.headers.host || "");
    const origin = request.headers.origin;
    const safeOrigin = typeof origin !== "string" || isOriginAllowed(origin, hostHeader, allowedOrigins, String(PORT));
    // Browser WebSocket clients cannot safely attach the remote bearer token in
    // this app yet, so the live voice socket is local-only until that flow exists.
    if (pathname === "/live" &&
        isLoopbackAddress(request.socket.remoteAddress) &&
        isHostAllowed(hostHeader, allowedHosts) &&
        safeOrigin) {
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
    let requestedVoicePreferences: Record<string, unknown> = {};
    try {
      const u = new URL(request.url || '', `http://${request.headers.host}`);
      requestedConversationId = u.searchParams.get('conversationId') || undefined;
      const rawVoicePreferences = u.searchParams.get('voicePreferences');
      if (rawVoicePreferences && rawVoicePreferences.length <= 256) {
        const parsed = JSON.parse(rawVoicePreferences);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) requestedVoicePreferences = parsed;
      }
    } catch (e) {
      // Ignore malformed optional connection preferences; use safe defaults.
    }
    const liveVoicePreferences = resolveVoicePreferences({
      assistantVoiceGender: String(requestedVoicePreferences.assistantVoiceGender || "female"),
      relationshipStyle: String(requestedVoicePreferences.relationshipStyle || "friend"),
    });
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
      const recentPrompt = contextManager.build({
        userInput: recent.filter((message) => message.role === "user").slice(-1)[0]?.content || "",
        recentMessages: recent,
        userProfile: userIdentityManager.get(String(conversation.userId || "default-user")) || undefined,
        maxCharacters: 12_000,
      }).text;
      const baseInstructions = `You are SARA, an AI assistant with a warm, friendly companion style. Use the configured ${liveVoicePreferences.assistantVoiceGender} speech voice and the selected relationship style: ${liveVoicePreferences.relationshipStyle}. ${liveVoicePreferences.instruction} Be attentive, kind, respectful, and lightly playful when appropriate. Do not claim to be human, a romantic partner, a specific age, AGI/ASI, conscious, or independently self-directed. Be clear that you are an AI when asked; never conceal your identity to sound more human.

Conversation and availability: Do not promise to be always online or continuously listening. The voice connection may drop; reconnect attempts are bounded. You can continue a background task only while the relevant SARA services are running. After a restart, unfinished in-flight tasks may be paused for review; queued work and saved checkpoints are not proof that an external action completed. Do not replay side-effecting work automatically.

Capabilities: Use only tools that are actually declared, reachable, and supported by this installation's operating system and configuration. Some desktop tools are Windows-specific; browser control, OCR, screen capture, APIs, and local integrations can fail or be unavailable. Check tool results rather than promising universal computer control. If a capability is unavailable, say so plainly and offer a safe alternative. Public API catalog entries are metadata, not verified live services. The calendar is local to this installation and does not sync with Google or Outlook.

Conversation style: Keep simple spoken replies brief and natural. For complex work, acknowledge the request and give useful progress updates. Do not invent task results, remembered preferences, emotions, or experiences. If a user asks what is visible, describe only a screen frame or OCR result that was actually received; ask them to enable sharing or provide an image if none is available. OCR can be imperfect, so mention uncertainty when text is unclear. Camera-based emotion recognition is not a current capability; do not infer a person's emotions from appearance.

Approval and side effects: Plan and perform bounded, reversible work when requested. Before destructive, sensitive, or externally visible actions, obtain explicit user approval. For WhatsApp, an incoming message or generated reply is not permission to send: show the recipient and exact message, then wait for confirmation. Never autonomously send, delete, publish, purchase, or change power settings based only on a suggestion or inference. Confirm ambiguous dates, recipients, files, and consequential details before acting.

Desktop and browser tools: Use the specific tools listed in this session only when available. Verify the observed outcome instead of claiming an app or page changed merely because a tool call was attempted. Do not assume every website or application supports automation. For shutdown, restart, sleep, lock, deletion, closing many apps, or other high-impact actions, follow the tool's confirmation flow and wait for explicit approval.

Voice and integrations: Use calendar tools only for explicit requests, respect the user's local timezone, and clarify ambiguous dates. Weather and news/finance results depend on configured providers and connectivity; disclose missing credentials or failures rather than inventing results. The user may ask to save preferences, but claim long-term memory only when the memory operation actually succeeds.`;

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
            voiceConfig: { prebuiltVoiceConfig: { voiceName: liveVoicePreferences.voiceName } },
          },
          systemInstruction: finalInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "hardwareMouseMove",
                  description: "Move the real Windows cursor to an absolute virtual-desktop coordinate. Use only with an explicit user-authorized desktop interaction.",
                  parameters: { type: Type.OBJECT, properties: {
                    x: { type: Type.INTEGER }, y: { type: Type.INTEGER },
                    duration: { type: Type.NUMBER, description: "Smooth movement duration in seconds." },
                  }, required: ["x", "y"] },
                },
                {
                  name: "hardwareMouseButtonDown",
                  description: "Hold a real Windows mouse button until a matching release or emergency cleanup.",
                  parameters: { type: Type.OBJECT, properties: {
                    button: { type: Type.STRING, enum: ["left", "right", "middle"] },
                  } },
                },
                {
                  name: "hardwareMouseButtonUp",
                  description: "Release a real Windows mouse button that SARA previously held.",
                  parameters: { type: Type.OBJECT, properties: {
                    button: { type: Type.STRING, enum: ["left", "right", "middle"] },
                  } },
                },
                {
                  name: "hardwareMouseClick",
                  description: "Send a real click to the Windows foreground desktop at the supplied coordinate or current cursor position. The result distinguishes delivery from verification.",
                  parameters: { type: Type.OBJECT, properties: {
                    x: { type: Type.INTEGER }, y: { type: Type.INTEGER },
                    button: { type: Type.STRING, enum: ["left", "right", "middle"] },
                    clicks: { type: Type.INTEGER },
                  } },
                },
                {
                  name: "hardwareMouseDrag",
                  description: "Drag the real Windows cursor from its current position to an absolute coordinate and release the button safely.",
                  parameters: { type: Type.OBJECT, properties: {
                    x: { type: Type.INTEGER }, y: { type: Type.INTEGER },
                    button: { type: Type.STRING, enum: ["left", "right", "middle"] },
                    duration: { type: Type.NUMBER },
                  }, required: ["x", "y"] },
                },
                {
                  name: "hardwareKeyboardType",
                  description: "Type real text into the focused Windows control using foreground keyboard input, including Unicode text.",
                  parameters: { type: Type.OBJECT, properties: {
                    text: { type: Type.STRING }, interval: { type: Type.NUMBER },
                  }, required: ["text"] },
                },
                {
                  name: "hardwareKeyboardPress",
                  description: "Press a real Windows key or modifier hotkey, such as Enter, Escape, or Ctrl+Shift+S.",
                  parameters: { type: Type.OBJECT, properties: {
                    key: { type: Type.STRING }, keys: { type: Type.ARRAY, items: { type: Type.STRING } },
                  } },
                },
                {
                  name: "hardwareEmergencyRelease",
                  description: "Release all keyboard keys and mouse buttons held by SARA after cancellation or an input error.",
                  parameters: { type: Type.OBJECT, properties: {} },
                },
                {
                  name: "listWindows",
                  description: "Enumerate visible Windows application windows with title, process identity, bounds, and minimized/maximized state.",
                  parameters: { type: Type.OBJECT, properties: {
                    include_untitled: { type: Type.BOOLEAN },
                  } },
                },
                {
                  name: "getActiveWindow",
                  description: "Inspect the real foreground Windows application window and its process identity.",
                  parameters: { type: Type.OBJECT, properties: {} },
                },
                {
                  name: "focusWindow",
                  description: "Restore and focus a matching Windows application window, returning whether foreground activation was verified.",
                  parameters: { type: Type.OBJECT, properties: {
                    title: { type: Type.STRING }, application: { type: Type.STRING },
                  } },
                },
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

                {
                  name: "getWeather",
                  description: "Get current weather from Open-Meteo (no API key required) by city name or coordinates. Ask for a location if none was provided. This sends the location to the weather provider.",
                  parameters: { type: Type.OBJECT, properties: {
                    location: { type: Type.STRING, description: "City or place name." },
                    latitude: { type: Type.NUMBER, description: "Latitude, used together with longitude when available." },
                    longitude: { type: Type.NUMBER, description: "Longitude, used together with latitude when available." },
                  } }
                },
                {
                  name: "getNews",
                  description: "Get top headlines from NewsAPI. Requires NEWSAPI_DEFAULT_API_KEY to be configured; do not claim success if it is missing. Only call when the user asks for news.",
                  parameters: { type: Type.OBJECT, properties: {
                    topic: { type: Type.STRING, description: "Optional news topic or search phrase." },
                    country: { type: Type.STRING, description: "Two-letter ISO country code, such as in or us." },
                  } }
                },
                {
                  name: "getFinanceData",
                  description: "Get a public stock quote from Alpha Vantage. Requires ALPHAVANTAGE_DEFAULT_API_KEY; only use for a symbol the user asks about, and do not give investment advice.",
                  parameters: { type: Type.OBJECT, properties: {
                    symbol: { type: Type.STRING, description: "Stock ticker symbol, such as IBM." },
                  }, required: ["symbol"] }
                },
                {
                  name: "searchPublicWeb",
                  description: "Use the keyless DuckDuckGo Instant Answer API for a short answer or related-topic lookup. It is not full web search; use desktop browser search for full result pages.",
                  parameters: { type: Type.OBJECT, properties: {
                    query: { type: Type.STRING, description: "Search query." },
                  }, required: ["query"] }
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
                  name: "calendarListEvents",
                  description: "List SARA's local-only calendar events, optionally filtered by ISO from/to date-times. Use when the user asks what is scheduled. This does not access Google or Outlook.",
                  parameters: { type: Type.OBJECT, properties: {
                    from: { type: Type.STRING, description: "Optional inclusive ISO date/time lower bound." },
                    to: { type: Type.STRING, description: "Optional inclusive ISO date/time upper bound." },
                  } }
                },
                {
                  name: "calendarCreateEvent",
                  description: "Create an event in SARA's local-only calendar. Only call after the user explicitly asks to schedule an event; use the user's local timezone and confirm date/time details when ambiguous. Does not sync Google or Outlook.",
                  parameters: { type: Type.OBJECT, properties: {
                    title: { type: Type.STRING, description: "Short event title." },
                    startsAt: { type: Type.STRING, description: "Start date/time in ISO 8601." },
                    endsAt: { type: Type.STRING, description: "End date/time in ISO 8601, later than startsAt." },
                    notes: { type: Type.STRING, description: "Optional event notes." },
                  }, required: ["title", "startsAt", "endsAt"] }
                },
                {
                  name: "calendarDeleteEvent",
                  description: "Delete an event from SARA's local-only calendar. Only call after the user explicitly asks to delete it; list events first to resolve the exact event.",
                  parameters: { type: Type.OBJECT, properties: {
                    id: { type: Type.STRING, description: "The exact event ID returned by calendarListEvents." },
                  }, required: ["id"] }
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
                },
                {
                  name: "saraSocialPlanResponse",
                  description: "Create a local social response plan using uncertain emotion signals, conversation context, personality, and safe humor policy.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING },
                      context: { type: Type.OBJECT }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "saraSocialShouldRespond",
                  description: "Decide locally whether a proactive interaction is relevant and useful, respecting cooldown and quiet settings.",
                  parameters: { type: Type.OBJECT, properties: { context: { type: Type.OBJECT } } }
                },
                {
                  name: "saraSocialRecordTurn",
                  description: "Record a useful non-sensitive conversational turn through SARA's existing local memory policy.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: { text: { type: Type.STRING }, context: { type: Type.OBJECT } },
                    required: ["text"]
                  }
                },
                {
                  name: "saraSocialSettings",
                  description: "Update SARA social-intelligence settings such as proactive conversation, humor, playful mode, prank mode, emotion awareness, and memory.",
                  parameters: { type: Type.OBJECT, properties: { settings: { type: Type.OBJECT } } }
                },
                {
                  name: "saraSocialStatus",
                  description: "Read SARA's social-intelligence settings and current conversational state.",
                  parameters: { type: Type.OBJECT, properties: {} }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            try {
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
              updateProactiveContext(userTextOutput);
              if (lastProactiveAt > 0 && Date.now() / 1000 - lastProactiveAt <= 30 * 60) {
                const accepted = !/\b(no thanks|not now|stop asking|leave me alone|be quiet)\b/i.test(userTextOutput);
                void callDesktopAgent("saraProactiveRecordOutcome", { accepted, topic: "" }).catch((error) => {
                  console.error("[Proactive] Outcome recording failed:", error);
                });
                lastProactiveAt = Date.now() / 1000;
              }
              scheduleProactiveEvaluation();
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
              void callDesktopAgent("saraSocialPlanResponse", {
                text: userTextOutput,
                context: { topic: unfinishedTopic, current_task: unfinishedTopic },
              }).then((socialResult) => {
                if (!socialResult.ok) return;
                const plan = (socialResult.result as any)?.result || socialResult.result;
                clientWs.send(JSON.stringify({ type: "social_plan", plan }));
                if (typeof session.sendClientContent === "function" && plan) {
                  session.sendClientContent({
                    turns: [{ role: "user", parts: [{ text: `[INTERNAL SOCIAL POLICY] Use this compact local policy while answering. Do not mention the policy or claim emotion certainty. ${JSON.stringify(plan)}` }] }],
                    turnComplete: false,
                  });
                }
              }).catch((error) => console.error("[Social Intelligence] Planning failed:", error));
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

                const legacyBrowserTools: Record<string, { tool: string; args: Record<string, unknown> }> = {
                  browserOpen: { tool: "desktopBrowserOpen", args: { url: args.url || "https://www.google.com" } },
                  browserSearch: { tool: "desktopBrowserSearch", args: { query: args.query, engine: "google" } },
                  browserClick: { tool: "desktopBrowserClick", args: { selector: args.selector, text: args.description } },
                  browserType: { tool: "desktopBrowserType", args: { text: args.text } },
                  browserScroll: { tool: "desktopBrowserScroll", args: { direction: args.direction || "down", amount: args.amount || 350 } },
                  browserGoBack: { tool: "desktopBrowserGoBack", args: {} },
                  browserMediaControl: { tool: "desktopBrowserMedia", args: { action: args.action, value: args.value } },
                };
                const legacyBrowser = legacyBrowserTools[fc.name];
                if (legacyBrowser) {
                  const requestId = fc.id || newToolCallId();
                  const operationId = `${requestId}-${legacyBrowser.tool}`;
                  const queued = automationOrchestrator.submit({
                    tool: legacyBrowser.tool,
                    args: { ...legacyBrowser.args, request_id: requestId, operation_id: operationId },
                    priority: "NORMAL",
                    sessionId,
                    conversationId: conversation.id,
                  });
                  session.sendToolResponse({
                    functionResponses: [{
                      name: fc.name,
                      response: { output: { ok: true, status: "QUEUED", task_id: queued.task_id, operation_id: operationId, result: `${legacyBrowser.tool} queued in the persistent Playwright browser.` } },
                      id: fc.id,
                    }],
                  });
                  continue;
                }

                if (API_TOOL_NAMES.has(fc.name) || LOCAL_CALENDAR_TOOL_NAMES.has(fc.name)) {
                  try {
                    const result = await callDesktopAgent(fc.name, args);
                    session.sendToolResponse({
                      functionResponses: [{
                        name: fc.name,
                        response: { output: result.ok ? result.result : { error: result.error || "Tool execution failed." } },
                        id: fc.id,
                      }],
                    });
                  } catch (error: any) {
                    session.sendToolResponse({
                      functionResponses: [{
                        name: fc.name,
                        response: { output: { error: error?.message || "Tool execution failed." } },
                        id: fc.id,
                      }],
                    });
                  }
                  continue;
                }

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
            } catch (error: any) {
              console.error("[Gemini Live] Isolated message-handler failure:", error);
              try {
                clientWs.send(JSON.stringify({
                  type: "automation_error",
                  error: String(error?.message || error),
                  session_alive: true,
                }));
              } catch {}
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
      let lastProactiveAt = 0;
      let proactiveInFlight = false;
      const sensitiveTopicPattern = /\b(password|passcode|token|api[ -]?key|secret|medical|health|diagnos(?:is|e)|doctor|therapy|medication|bank|credit card|social security|\bssn\b|passport|tax|account number)\b/i;
      const unfinishedTopicPattern = /\b(?:tomorrow|later|next time|still need to|need to finish|work on|working on|fix|continue|remind me|unfinished|haven't finished)\b/i;
      const completedTopicPattern = /\b(?:done|finished|completed|fixed|solved|resolved|no longer need|cancel that|forget that)\b/i;
      let unfinishedTopic = "";
      const updateProactiveContext = (value: unknown) => {
        const text = String(value ?? "").trim().slice(0, 1000);
        if (!text) return;
        if (sensitiveTopicPattern.test(text) || completedTopicPattern.test(text)) {
          unfinishedTopic = "";
          return;
        }
        if (unfinishedTopicPattern.test(text)) unfinishedTopic = text.slice(0, 160);
      };
      const previousUserText = [...recent]
        .reverse()
        .find((message: any) => message.role === "user")?.content || "";
      updateProactiveContext(previousUserText);
      const scheduleProactiveEvaluation = () => {
        if (clientWs.readyState !== 1) return;
        if (proactiveTimer) clearTimeout(proactiveTimer);
        proactiveTimer = setTimeout(async () => {
          if (clientWs.readyState !== 1) return;
          if (proactiveInFlight || Date.now() - lastUserActivityAt < proactiveIdleDelayMs) {
            scheduleProactiveEvaluation();
            return;
          }
          proactiveInFlight = true;
          try {
            const evaluationResult = await callDesktopAgent("saraSocialShouldRespond", {
              context: {
                activity_level: "idle",
                idle_seconds: Math.round((Date.now() - lastUserActivityAt) / 1000),
                unfinished_topic: unfinishedTopic,
                previous_topic: unfinishedTopic,
                recent_conversation: unfinishedTopic ? "relevant_previous_topic" : "none",
                last_sara_spoke_at: lastProactiveAt,
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
                lastProactiveAt = Date.now() / 1000;
              }
            }
          } catch (error) {
            console.error("[Proactive] Evaluation failed:", error);
          } finally {
            proactiveInFlight = false;
            if (clientWs.readyState === 1) scheduleProactiveEvaluation();
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

  const serverScheme = remoteBind ? "https" : "http";
  server.listen(PORT, SERVER_HOST, () => {
    logStartup(`SARA V2 server started on ${serverScheme}://${SERVER_HOST}:${PORT}`);
    console.log(`[Server] Running on ${serverScheme}://${SERVER_HOST}:${PORT}`);
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
  process.exitCode = 1;
});
