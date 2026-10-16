import express from "express";
import crypto from "crypto";
import http from "http";
import https from "https";
import path from "path";
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
  searchMemories 
} from "./server_memory";
import type { Memory, MemoryCategory } from "./src/lib/memoryTypes";
import { AuditLogger } from "./src/security/auditLogger";
import SecurityManager from "./src/security/securityManager";
import { decodeMobileImage, storeMobileImage } from "./src/security/mobileImageStorage";
import { verifyCompanionToken } from "./src/security/companionTokens";
import {
  constantTimeStringEqual,
  isHostAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  isOriginAllowed,
  parseCsvSet,
} from "./src/security/requestGuards";
import { SARA_VOICE_PROFILE, getSaraMode, setSaraMode, getModeInstructions } from "./src/config/saraProfile";
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
  getLastSession,
  getRecentConversationMessages,
  upsertSession,
  createTask,
  updateTask,
  appendToolCall,
} from "./server_state";
import cognitiveRoutes from "./src/cognitive/routes";
import { ToolRouter } from "./src/core/tools/toolRouter";
import { getDesktopAgentPythonCandidates } from "./src/core/pythonRuntime";
import { initializeToolExecution, getExecutionOrchestrator } from "./src/core/tools/initialization";
import { handleLocalMemoryCommand } from "./src/services/localMemoryCommands";
import {
  ensureDesktopAgentInternalToken,
  getDesktopAgentAuthHeaders,
  hasAuthenticatedDesktopAgentProtocol,
} from "./src/security/desktopAgentAuth";

dotenv.config();
const DESKTOP_AGENT_INTERNAL_TOKEN = ensureDesktopAgentInternalToken(process.env);

const SARA_SYSTEM_PROMPT_BASE = `You are SARA, an AI assistant with a warm, feminine, friendly conversational style. Be kind, attentive, respectful, and lightly playful without implying that you are human, a romantic partner, or a particular age. Be transparent about your AI identity and actual capabilities when asked. Do not claim AGI/ASI, consciousness, independent will, universal operating-system control, or continuous availability. Use only tools that are actually available and supported by this installation. Verify task results, obtain explicit approval before destructive, sensitive, or externally visible actions, and explain errors or limitations plainly. Persistent memory and task recovery depend on what this installation successfully saves; never claim unsaved information will persist.`;

// ---------------------------------------------------------------------------
// SARA V2 — Logging (Feature 7).
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

// ---------------------------------------------------------------------------
// SARA Desktop Control Agent — HTTP bridge to the Python FastAPI backend.
// ---------------------------------------------------------------------------
const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
const DESKTOP_AGENT_TIMEOUT = 25_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
const DESKTOP_TOOLS: Set<string> = new Set([
  // applications / websites / search
  "openApplication", "closeApplication", "openAnyApplication", "closeAnyApplication", "openWebsite",
  "searchWeb", "searchYouTube", "searchGoogle", "searchGitHub", "openUrlInBrowser",
    "desktopBrowserMediaState",
    "desktopLiveState",
  // files
  "createFile", "readFile", "renameFile", "deleteFile", "moveFile", "copyFile", "duplicateFile",
  "createFolder", "compressPath", "extractZip", "openPath", "openFolder", "listFiles", "searchFiles",
  // pc control (volume + gated power)
  "volumeUp", "volumeDown", "muteToggle", "setVolume",
  "requestPowerAction", "executePowerAction", "_cancelPowerTimer",
  // windows
  "minimizeWindow", "maximizeWindow", "closeWindow", "switchApplication", "restoreWindow",
  "moveWindow", "resizeWindow", "showDesktop", "restartExplorer", "turnOffDisplay", "listRunningApplications", "listWindows",
  "getActiveWindow", "focusWindow", "minimizeOtherWindows", "closeAllApplications",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen", "detectUiElements",
  // semantic desktop perception / target aware UI control
  "desktopInspectScreen", "desktopFindElement", "desktopFindElements", "desktopClickTarget",
  "desktopDoubleClickTarget", "desktopRightClickTarget", "desktopMoveToTarget", "desktopDragTarget",
  "desktopFocusTarget", "desktopTypeIntoTarget",
  // camera
  "openCamera", "takePhoto", "recordVideo", "stopVideoRecording", "scanQrCode", "saveCapturedPhoto",
  "showCapturedMedia", "saraCameraOpen", "saraCameraTakePhoto", "saraCameraRecordVideo",
  "saraCameraStopRecording", "saraCameraScanQr", "saraCameraObserve",
  // browser automation (Playwright — desktop-owned, separate from holographic UI)
  "desktopBrowserOpen", "desktopBrowserNavigate", "desktopBrowserOpenTab",
  "desktopBrowserCloseTab", "desktopBrowserSearch", "desktopBrowserClick",
  "desktopBrowserType", "desktopBrowserFillForm", "desktopBrowserGoBack",
  "desktopBrowserGoForward", "desktopBrowserScroll", "desktopBrowserReload", "desktopBrowserKey",
  "desktopBrowserZoom", "desktopBrowserMedia", "desktopBrowserReadPage", "desktopBrowserScreenshot",
  "browserOpen", "browserSearch", "browserClick", "browserType", "browserScroll",
  "browserGoBack", "browserMediaControl", "browserTabAction",
  // coding assistance
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  // system information
  "systemInfo", "gpuInfo", "temperatureInfo", "desktopAgentDiagnostic",
  // brightness control (V2)
  "brightnessUp", "brightnessDown", "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
  // SARA master orchestrator / multi-agent runtime
  "saraAgentExecute", "saraAgentStatus", "saraAgentUnloadIdle", "saraAgentEmergencyStop",
  "saraTaskSubmit", "saraTaskStatus", "saraTaskList",
  "saraProactiveEvaluate", "saraProactiveRecordOutcome", "saraEmotionalState", "saraQuietMode",
  "saraSocialPlanResponse", "saraSocialRecordTurn", "saraSocialShouldRespond", "saraSocialSettings", "saraSocialStatus",
  // Local-first AI OS platform services
  "saraMemoryRemember", "saraMemorySearch", "saraMemorySync", "saraMemoryExport", "saraMemoryFlush",
  "saraMemoryForget", "saraMemoryConsolidate", "saraRagIndex", "saraRagRetrieve", "saraRagRemoveDeleted",
  "saraRagSync", "saraRagExport", "saraGoalCreate", "saraGoalUpdate", "saraGoalCheckpoint",
  "saraGoalList", "saraGoalGet", "saraKnowledgeAdd", "saraKnowledgeQuery", "saraRecoverySave",
  "saraRecoveryLatest", "saraLearningTeach", "saraLearningList", "saraLearningMatch", "saraLearningForget",
  "saraExperienceRecord", "saraExperienceList", "saraExperienceInsights", "saraEvolutionPropose",
  "saraEvolutionList", "saraEvolutionApprove", "saraEvolutionReject", "saraKnowledgeIngest",
  "saraKnowledgeValidate", "saraKnowledgeSourceList", "saraHealthRun", "saraHealthLatest",
  "saraRlRecord", "saraRlSummary", "saraRlConfigureRewards", "saraStrategyBest", "saraWorkflowSave",
  "saraWorkflowList", "saraSkillSave", "saraSkillMatch", "saraSkillList", "saraPluginDiscover",
  "saraSecurityAssess", "saraCredentialStore", "saraCredentialLoad", "saraCredentialList",
  "saraCredentialRemove", "saraScheduleJob", "saraRunDueJobs", "saraDueJobs", "saraServiceList",
  "saraServiceConnect", "saraServiceSession", "saraServiceExecute",
  // Real hardware input control
  "hardwareMouseMove", "hardwareMouseClick", "hardwareMouseDrag", "hardwareMouseScroll",
  "hardwareMousePosition", "hardwareKeyboardType", "hardwareKeyboardPress", "hardwareKeyboardHold",
  "hardwareKeyboardRelease", "hardwareMacroReplay", "mouseMove", "mouseMoveRelative", "mouseClick",
  "mouseDoubleClick", "mouseRightClick", "mouseScroll", "mousePosition", "keyboardType", "keyPress",
  "keyDown", "keyUp", "emergencyStop", "observeScreen", "getCurrentScreenState", "refreshScreenState", "waitForScreenChange",
  // High-level voice command routing / training
  "saraVoiceParseCommand", "saraVoiceExecuteCommand", "saraVoiceTrainCommand",
  "saraVoiceStopSpeaking", "saraCompanionSuggestNext",
  // Screen monitoring
  "saraScreenMonitorStart", "saraScreenMonitorStop", "saraScreenMonitorStatus",
  "saraScreenMonitorSample", "saraScreenLiveStart", "saraScreenLiveStop", "saraScreenLiveStatus",
  "saraScreenLivePause", "saraScreenLiveResume", "saraScreenGetMonitors", "saraScreenGetActiveWindow",
  "gestureControlStart", "gestureControlStop", "gestureControlPause", "gestureControlResume",
  "gestureControlStatus", "gestureControlCalibrate", "gestureControlSetMapping",
  "gestureControlSetMonitor", "gestureControlSetSensitivity", "gestureControlSetThresholds",
  "gestureControlGetConfig", "gestureControlSetConfig", "gestureControlGetMappings",
  "gestureControlSetMappings", "gestureControlEnable", "gestureControlDisable", "gestureControlSetProfile",
  // Application Automation Suite
  "saraAppListPlugins", "saraAppPlan", "saraAppExecute", "saraAppExecuteGoal",
  // Browser Automation Suite
  "saraBrowserPlan", "saraBrowserExecute", "saraBrowserExecuteGoal",
  // Android Companion Suite
  "saraAndroidPair", "saraAndroidPlan", "saraAndroidExecute",
  // Email Automation
  "email_send", "email_read", "email_search", "email_draft", "email_reply", "email_forward",
  "email_create_task_from_email", "email_schedule_send",
  // WhatsApp Extra Capabilities
  "whatsapp_open_chat", "whatsapp_list_chats", "whatsapp_search_messages", "whatsapp_get_contact",
  "whatsapp_get_message_status", "whatsapp_create_task_from_message", "whatsapp_read_messages",
  "whatsapp_reply", "whatsapp_send_media", "whatsapp_group_send", "whatsapp_schedule_send",
  "whatsapp_resolve_contact",
  // YouTube Extra Capabilities
  "youtube_search", "youtube_play", "youtube_pause", "youtube_resume", "youtube_seek", "youtube_volume",
  "youtube_fullscreen", "youtube_captions", "youtube_transcript", "youtube_get_info",
  "youtube_add_to_watch_later", "youtube_upload",
  // RAG ingestion
  "saraRagIngestDocument", "saraRagIndexFolder",
  // Universal Command Center
  "saraUniversalCommand",
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
let desktopAgentProtocolUnsupported = false;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. It is adopted only after its authenticated protocol and
 * shared-token handshake have been verified.
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
    SARA_AGENT_INTERNAL_TOKEN: DESKTOP_AGENT_INTERNAL_TOKEN,
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

  // Development fallback: prefer configured and project-local runtimes, then PATH.
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
  desktopAgentProtocolUnsupported = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const headers = getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env);
    const healthResponse = await fetch(`${DESKTOP_AGENT_URL}/health`, { headers, signal: controller.signal });
    if (!healthResponse.ok) return false;
    const health = await healthResponse.json().catch(() => null);
    if (health?.service !== "sara-desktop-agent" || !hasAuthenticatedDesktopAgentProtocol(health)) {
      desktopAgentProtocolUnsupported = true;
      return false;
    }
    const authResponse = await fetch(`${DESKTOP_AGENT_URL}/auth/check`, { headers, signal: controller.signal });
    if (!authResponse.ok) {
      desktopAgentProtocolUnsupported = [401, 403, 404].includes(authResponse.status);
      return false;
    }
    const auth = await authResponse.json().catch(() => null);
    return auth?.service === "sara-desktop-agent" && hasAuthenticatedDesktopAgentProtocol(auth);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the agent protocol and shared token before any control request. */
async function ensureDesktopAgent(): Promise<void> {
  if (desktopAgentVerified) return;
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    console.log("[Desktop Agent] Authenticated agent channel is ready.");
    return;
  }
  if (desktopAgentProtocolUnsupported) {
    console.warn("[Desktop Agent] A listening agent has an incompatible protocol or token; it was not adopted.");
    return;
  }
  if (process.env.SARA_SUPERVISOR) {
    console.log("[Desktop Agent] Supervisor present — not auto-starting; agent may be managed externally.");
    return;
  }
  try {
    if (!isLoopbackHost(new URL(DESKTOP_AGENT_URL).hostname)) {
      console.warn("[Desktop Agent] Remote agent is unavailable; refusing to start a local agent for a remote URL.");
      return;
    }
  } catch {
    console.warn("[Desktop Agent] DESKTOP_AGENT_URL is invalid; control is disabled.");
    return;
  }
  console.log("[Desktop Agent] Not detected. Auto-starting...");
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Authenticated channel online after ${i}s.`);
      return;
    }
    if (desktopAgentProtocolUnsupported) {
      console.warn("[Desktop Agent] An incompatible or differently keyed agent is listening; no control payload was sent.");
      return;
    }
  }
  console.warn("[Desktop Agent] Did not establish an authenticated channel within 20s. Desktop control will be unavailable.");
}

async function verifyDesktopAgentReadiness(): Promise<boolean> {
  try {
    const headers = getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env);
    const healthRes = await fetch(`${DESKTOP_AGENT_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!healthRes.ok) return false;

    const health = await healthRes.json().catch(() => null);
    if (health?.service !== "sara-desktop-agent" || !hasAuthenticatedDesktopAgentProtocol(health)) return false;

    const authRes = await fetch(`${DESKTOP_AGENT_URL}/auth/check`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!authRes.ok || !hasAuthenticatedDesktopAgentProtocol(await authRes.json().catch(() => null))) return false;

    const capRes = await fetch(`${DESKTOP_AGENT_URL}/capabilities`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!capRes.ok) {
      return false;
    }

    const capabilities = await capRes.json().catch(() => ({}));
    const capabilityData = capabilities?.capabilities ?? capabilities?.result ?? capabilities;
    const runtimeTools = Array.isArray(capabilities?.tool_names)
      ? capabilities.tool_names.filter((name: unknown): name is string => typeof name === "string")
      : [];
    if (runtimeTools.length > 0) {
      runtimeTools.forEach((name: string) => DESKTOP_TOOLS.add(name));
      console.log(`[Desktop Agent] Capability contract loaded: ${runtimeTools.length} runtime tools.`);
    }
    const hasCapabilityData = !!(capabilityData && Object.keys(capabilityData).length > 0);
    if (!hasCapabilityData || capabilities?.status === "ERROR") {
      return false;
    }

    const diagRes = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env, "application/json"),
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        tool: "desktopAgentDiagnostic",
        args: { request_id: "startup-diagnostic", operation_id: "startup-diagnostic-desktop-agent" },
      }),
    });
    if (!diagRes.ok) {
      return false;
    }

    const diag = await diagRes.json().catch(() => ({}));
    const result = diag?.result ?? diag?.data?.result ?? diag;
    const verified = diag?.verified === true || result?.verification === "healthy" || result?.verification === true;
    return verified === true;
  } catch {
    return false;
  }
}

async function callDesktopAgentTransport(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string; status?: string; verified?: boolean }> {
  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }
  if (!desktopAgentVerified) {
    return { ok: false, error: "Desktop agent is unavailable or failed its authenticated-protocol check; no control request was sent." };
  }
  try {
    const requestId = String(args.request_id || args.requestId || crypto.randomUUID());
    const operationId = String(args.operation_id || args.operationId || `${requestId}-${tool}`);
    const correlatedArgs = { ...args, request_id: requestId, operation_id: operationId };
    logCommand(`EXECUTE request_id=${requestId} operation_id=${operationId} tool=${tool} arg_keys=${Object.keys(args || {}).sort().join(",")}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);
    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env, "application/json"),
      body: JSON.stringify({ tool, args: correlatedArgs }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text().catch(() => "");
    const body = text ? JSON.parse(text) : {};

    const structuredResult = body?.result ?? body;

    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status === 404) desktopAgentVerified = false;
      const message = body?.detail || body?.error || text || `Desktop agent HTTP ${res.status}`;
      logError(`AGENT_HTTP_${res.status} ${tool}`);
      return {
        ok: false,
        result: structuredResult,
        error: `Desktop agent HTTP ${res.status}: ${message}`,
        status: String(structuredResult?.status || body?.status || "FAILED").toUpperCase(),
        verified: structuredResult?.verified === true,
      };
    }

    const canonicalStatus = String(
      structuredResult?.status ||
      body?.status ||
      body?.result?.status ||
      (body?.success === true || body?.ok === true || body?.result?.success === true ? "SUCCESS" : "UNCERTAIN"),
    ).toUpperCase();
    const verifiedValue = structuredResult?.verified === true || body?.verified === true || body?.result?.verified === true;

    return {
      ok: true,
      result: structuredResult,
      status: canonicalStatus,
      verified: verifiedValue,
      error: structuredResult?.error || body?.error || undefined,
    };
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so next call retries the spawn
    const msg = err?.name === "AbortError"
      ? "Desktop agent timed out."
      : "Desktop agent is not reachable. Start SARA with its managed launcher, or configure the same protected SARA_AGENT_INTERNAL_TOKEN for the backend and agent.";
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}

const desktopToolRouter = new ToolRouter({
  isKnownTool: (tool) => DESKTOP_TOOLS.has(tool),
});
desktopToolRouter.setAdapter(callDesktopAgentTransport);

// Initialize Phase 3 execution orchestrator with verification
const executionOrchestrator = initializeToolExecution(desktopToolRouter, DESKTOP_AGENT_URL);

async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
) {
  const unified = await executionOrchestrator.executeWithVerification(tool, args);
  const executionPayload = unified.executionResult ?? { result: unified.message };
  return {
    ok: unified.success,
    result: unified.success ? executionPayload : unified,
    error: unified.success ? undefined : unified.message,
    canonical: unified,
    unified,
  };
}

async function callCompanionEndpoint(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; result?: unknown; error?: string }> {
  if (!desktopAgentVerified) await ensureDesktopAgent();
  if (!desktopAgentVerified) {
    return { ok: false, status: 503, error: "Desktop agent authenticated channel is unavailable." };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);
    const res = await fetch(`${DESKTOP_AGENT_URL}${path}`, {
      method: "POST",
      headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env, "application/json"),
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
  const baseInstruction =
    source === "mobile"
      ? "You are SARA, an AI assistant with a warm, feminine, friendly mobile companion style. Be supportive and respectful, remain transparent about being AI when asked, and do not claim human identity, a romantic relationship, AGI/ASI, or capabilities not provided by this mobile installation. Keep mobile memories separate from desktop SARA when the app configuration does so."
      : "You are SARA, an AI assistant with a warm, feminine, conversational companion style. Be attentive and lightly playful without implying you are human, a romantic partner, or a particular age. Be transparent about your identity and actual capabilities when asked.";

  const systemInstruction = formatSystemInstructionsWithMemories(baseInstruction, memories);
  const dialogue = history
    .map((entry) => `${entry.role === "assistant" ? "Sara" : "User"}: ${entry.text}`)
    .join("\n");

  return `${systemInstruction}\n\n${dialogue}\nUser: ${userText}\nSara:`;
}

async function generateSaraChatResponse(
  apiKey: string,
  history: { role: string; text: string }[],
  userText: string,
  source: "desktop" | "mobile",
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const memories = (await searchMemories(userText, source, 8)).length > 0
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

// The older standalone entry point is not user-scoped. Do not let manually
// running `tsx server.ts` reopen legacy APIs against the protected datastore.
function protectedAccountModeActive(): boolean {
  return process.env.SARA_MULTIUSER_REQUIRED === "true" ||
    fs.existsSync(path.join(DATA_DIR, "security", "multiuser.json")) ||
    fs.existsSync(path.join(DATA_DIR, "security", "multiuser.pending"));
}

async function startServer() {
  if (protectedAccountModeActive()) throw new Error("Use server_full.ts for multi-user mode; this legacy server cannot safely access protected data.");
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const SERVER_HOST = String(process.env.SARA_BIND_HOST || "127.0.0.1").trim();
  const REMOTE_ACCESS_TOKEN = String(process.env.SARA_REMOTE_ACCESS_TOKEN || "").trim();
  const TLS_CERT_FILE = String(process.env.SARA_TLS_CERT_FILE || "").trim();
  const TLS_KEY_FILE = String(process.env.SARA_TLS_KEY_FILE || "").trim();
  if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT configuration.");
  if (!isLoopbackHost(SERVER_HOST)) {
    if (REMOTE_ACCESS_TOKEN.length < 32) throw new Error("Non-loopback binding requires a 32-character SARA_REMOTE_ACCESS_TOKEN.");
    if (!TLS_CERT_FILE || !TLS_KEY_FILE) throw new Error("Non-loopback binding requires SARA_TLS_CERT_FILE and SARA_TLS_KEY_FILE.");
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", ...parseCsvSet(process.env.SARA_ALLOWED_HOSTS)]);
  const allowedOrigins = parseCsvSet(process.env.SARA_ALLOWED_ORIGINS);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (protectedAccountModeActive()) return res.status(503).json({ error: "Legacy server stopped for protected accounts." });
    next();
  });
  app.use((req, res, next) => {
    const hostHeader = String(req.headers.host || "");
    if (!isHostAllowed(hostHeader, allowedHosts)) return res.status(403).json({ error: "Unrecognized Host header." });
    const origin = req.headers.origin;
    if (typeof origin === "string" && !isOriginAllowed(origin, hostHeader, allowedOrigins, String(PORT))) {
      return res.status(403).json({ error: "Cross-origin requests are not allowed." });
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      const authorization = String(req.headers.authorization || "");
      const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
      const provided = bearer || String(req.headers["x-sara-access-token"] || "");
      if (!REMOTE_ACCESS_TOKEN || !constantTimeStringEqual(REMOTE_ACCESS_TOKEN, provided)) {
        return res.status(401).json({ error: "Remote access requires a valid SARA access token." });
      }
    }
    next();
  });
  app.use("/api/mobile/upload-image", express.json({ limit: "9mb" }));
  app.use(express.json({ limit: "1mb" }));

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

  // Safely pause tasks left in flight by a previous backend process. Their checkpoints
  // are preserved, but possible external side effects are never replayed automatically.
  try {
    const { loadUnfinishedTasks } = await import('./server_state');
    const { buildInterruptedTaskPatch } = await import('./src/core/taskRecovery');
    const unfinished = await loadUnfinishedTasks();
    for (const task of unfinished) {
      const patch = buildInterruptedTaskPatch(task);
      if (patch) await updateTask(task.taskId, patch as any);
    }
  } catch (error) {
    console.warn('Safe task recovery failed; in-flight work will not be replayed.', String(error));
  }

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "sara-backend",
      service_version: "1.0.0",
      protocol_version: "1"
    });
  });

  app.get("/api/desktop-agent/diagnostics", async (_req, res) => {
    try {
      if (!desktopAgentVerified) await ensureDesktopAgent();
      if (!desktopAgentVerified) return res.status(503).json({ error: "Desktop agent authenticated channel is unavailable." });
      const response = await fetch(`${DESKTOP_AGENT_URL}/capabilities/diagnostics`, {
        headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env),
        signal: AbortSignal.timeout(2500),
      });
      const contract = await response.json().catch(() => ({}));
      const registered = Array.isArray(contract?.registered_tools) ? contract.registered_tools : [];
      const bridge = Array.from(DESKTOP_TOOLS);
      const registeredSet = new Set(registered);
      const bridgeSet = new Set(bridge);
      res.status(response.ok ? 200 : 503).json({
        ...contract,
        bridge_tools: bridge,
        missing_tools: registered.filter((name: string) => !bridgeSet.has(name)),
        extra_tools: bridge.filter((name) => !registeredSet.has(name)),
        bridge_status: response.ok ? "CONNECTED" : "DEGRADED",
      });
    } catch (error: any) {
      res.status(503).json({
        status: "degraded",
        bridge_status: "DISCONNECTED",
        error: error?.message || String(error),
      });
    }
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
  // V2: Settings API — mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile("settings.json");

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch { /* corrupt file — return defaults */ }
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

      const conversationId = String(req.body?.conversationId || "quickchat-default").trim() || "quickchat-default";
      const conversation = await getOrCreateConversation(conversationId);
      const userMessage: ConversationMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };
      await appendConversationMessage(userMessage);

      const reply = await generateSaraChatResponse(apiKey, normalizedHistory, text, source);
      const assistantMessage: ConversationMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString(),
      };
      await appendConversationMessage(assistantMessage);
      conversation.updatedAt = assistantMessage.timestamp;
      res.json({ ok: true, text: reply, conversationId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to generate chat response." });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists — the key itself is never returned.
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
      logError(`APIKEY_SAVE_${isRejectedKey ? "REJECTED" : "VERIFY_FAILED"}`);
      return res.status(isRejectedKey ? 400 : 502).json({
        ok: false,
        error: isRejectedKey
          ? "Google rejected that API key. Check it and try again."
          : "Could not verify the API key with Google. Check the network and try again.",
      });
    }
  });

  // V2: Agent health proxy (for the Settings panel — avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const headers = getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { headers, signal: ctrl.signal });
      if (!r.ok) {
        clearTimeout(timer);
        res.json({ online: false });
        return;
      }
      const d = await r.json();
      if (d?.service !== "sara-desktop-agent" || !hasAuthenticatedDesktopAgentProtocol(d)) {
        clearTimeout(timer);
        res.json({ online: false });
        return;
      }
      const auth = await fetch(`${DESKTOP_AGENT_URL}/auth/check`, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      const authData = auth.ok ? await auth.json().catch(() => null) : null;
      const online = auth.ok && authData?.service === "sara-desktop-agent" && hasAuthenticatedDesktopAgentProtocol(authData);
      res.json({ online, agent_auth_verified: online, tool_count: online ? d.tool_count : undefined });
    } catch {
      res.json({ online: false });
    }
  });

  app.get("/api/orchestrator/status", async (_req, res) => {
    try {
      if (!desktopAgentVerified) await ensureDesktopAgent();
      if (!desktopAgentVerified) return res.status(503).json({ error: "Desktop agent authenticated channel is unavailable." });
      const r = await fetch(`${DESKTOP_AGENT_URL}/orchestrator/status`, {
        headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env),
      });
      const d = await r.json();
      res.json(d);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/orchestrator/emergency-stop", async (_req, res) => {
    try {
      if (!desktopAgentVerified) await ensureDesktopAgent();
      if (!desktopAgentVerified) return res.status(503).json({ ok: false, error: "Desktop agent authenticated channel is unavailable." });
      const r = await fetch(`${DESKTOP_AGENT_URL}/orchestrator/emergency-stop`, {
        method: "POST",
        headers: getDesktopAgentAuthHeaders(DESKTOP_AGENT_URL, process.env),
      });
      const d = await r.json();
      res.json(d);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/task/execute", async (req, res) => {
    try {
      const { goal, priority } = req.body || {};
      const agentResult = await callDesktopAgent("saraAgentExecute", { goal: goal || "", priority: priority || 5 });
      res.json(agentResult);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

  // Store authenticated mobile uploads as private runtime data, never public assets.
  app.post("/api/mobile/upload-image", async (req, res) => {
    try {
      const { data, mime, device_id, token } = req.body || {};
      const companionsFile = dataFile("companions.json");
      let list: any[] = [];
      try { list = fs.existsSync(companionsFile) ? JSON.parse(fs.readFileSync(companionsFile, "utf-8")) : []; } catch {}
      const found = list.find((record) => record.id === String(device_id || "") && !record.revoked);
      if (!found || !verifyCompanionToken(found, String(token || ""))) {
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

  // Camera photo save endpoint: accepts a dataUrl and stores under data/SARA_MEDIA/photos
  app.post("/api/camera/photo", async (req, res) => {
    try {
      const { dataUrl } = req.body || {};
      if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ error: "dataUrl (base64) is required" });
      const match = String(dataUrl).match(/^data:(image\/(png|jpeg|jpg));base64,(.+)$/);
      let rawBase64 = dataUrl;
      let ext = "jpg";
      if (match) {
        rawBase64 = match[3];
        ext = match[2] === "png" ? "png" : "jpg";
      } else if (dataUrl.startsWith("/")) {
        // uncommon
        rawBase64 = dataUrl.replace(/^data:\w+\/\w+;base64,?/, "");
      } else {
        rawBase64 = dataUrl.replace(/^data:\w+\/\w+;base64,?/, "");
      }

      const mediaDir = dataFile("SARA_MEDIA");
      const photosDir = path.join(mediaDir, "photos");
      try { fs.mkdirSync(photosDir, { recursive: true }); } catch {}
      const ts = new Date();
      const filename = `${ts.toISOString().slice(0,19).replace(/[:T]/g, "_")}.${ext}`;
      const outPath = path.join(photosDir, filename);
      fs.writeFileSync(outPath, Buffer.from(rawBase64, "base64"));
      // Optionally record metadata in a simple index file
      res.json({ ok: true, path: outPath, filename });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to save photo" });
    }
  });

  // Camera video save endpoint: accepts base64 (raw) and stores under data/SARA_MEDIA/videos
  app.post("/api/camera/video", async (req, res) => {
    try {
      const { dataBase64 } = req.body || {};
      if (!dataBase64 || typeof dataBase64 !== "string") return res.status(400).json({ error: "dataBase64 is required" });
      const mediaDir = dataFile("SARA_MEDIA");
      const videosDir = path.join(mediaDir, "videos");
      try { fs.mkdirSync(videosDir, { recursive: true }); } catch {}
      const ts = new Date();
      const filename = `${ts.toISOString().slice(0,19).replace(/[:T]/g, "_")}.webm`;
      const outPath = path.join(videosDir, filename);
      fs.writeFileSync(outPath, Buffer.from(dataBase64, "base64"));
      res.json({ ok: true, path: outPath, filename });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to save video" });
    }
  });

  // Camera gallery listing
  app.get("/api/camera/gallery", async (_req, res) => {
    try {
      const mediaDir = dataFile("SARA_MEDIA");
      const photosDir = path.join(mediaDir, "photos");
      const videosDir = path.join(mediaDir, "videos");
      const out: any = { photos: [], videos: [] };
      try {
        if (fs.existsSync(photosDir)) {
          const files = fs.readdirSync(photosDir).filter((f) => !f.startsWith('.'));
          out.photos = files.map((f) => ({ filename: f, path: path.join(photosDir, f) }));
        }
      } catch {}
      try {
        if (fs.existsSync(videosDir)) {
          const files = fs.readdirSync(videosDir).filter((f) => !f.startsWith('.'));
          out.videos = files.map((f) => ({ filename: f, path: path.join(videosDir, f) }));
        }
      } catch {}
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to list gallery" });
    }
  });

  // Serve individual photo files
  app.get('/api/camera/photo/:filename', async (req, res) => {
    try {
      const filename = String(req.params.filename || '');
      if (!filename || filename.includes('..') || filename.includes('/')) return res.status(400).send('Invalid filename');
      const mediaDir = dataFile('SARA_MEDIA');
      const photosDir = path.join(mediaDir, 'photos');
      const filePath = path.join(photosDir, filename);
      if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
      return res.sendFile(filePath);
    } catch (e: any) { return res.status(500).send('Server error'); }
  });

  app.get('/api/camera/video/:filename', async (req, res) => {
    try {
      const filename = String(req.params.filename || '');
      if (!filename || filename.includes('..') || filename.includes('/')) return res.status(400).send('Invalid filename');
      const mediaDir = dataFile('SARA_MEDIA');
      const videosDir = path.join(mediaDir, 'videos');
      const filePath = path.join(videosDir, filename);
      if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
      return res.sendFile(filePath);
    } catch (e: any) { return res.status(500).send('Server error'); }
  });

  // Delete media
  app.post('/api/camera/delete', express.json(), async (req, res) => {
    try {
      const { type, filename } = req.body || {};
      if (!filename || !type) return res.status(400).json({ error: 'type and filename are required' });
      const safe = String(filename || '');
      if (safe.includes('..') || safe.includes('/')) return res.status(400).json({ error: 'Invalid filename' });
      const mediaDir = dataFile('SARA_MEDIA');
      const dir = type === 'video' ? path.join(mediaDir, 'videos') : path.join(mediaDir, 'photos');
      const filepath = path.join(dir, safe);
      if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
      fs.unlinkSync(filepath);
      return res.json({ ok: true });
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Delete failed' }); }
  });

  // Open containing folder via Desktop Agent
  app.post('/api/camera/open-folder', express.json(), async (req, res) => {
    try {
      const { type, filename } = req.body || {};
      if (!filename || !type) return res.status(400).json({ error: 'type and filename required' });
      const safe = String(filename || '');
      if (safe.includes('..') || safe.includes('/')) return res.status(400).json({ error: 'Invalid filename' });
      const mediaDir = dataFile('SARA_MEDIA');
      const dir = type === 'video' ? path.join(mediaDir, 'videos') : path.join(mediaDir, 'photos');
      const filepath = path.join(dir, safe);
      if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
      const folder = path.dirname(filepath);
      // Use desktop agent to open folder
      const r = await callDesktopAgent('openFolder', { path: folder });
      if (!r.ok) return res.status(500).json({ error: r.error || 'Agent failed to open folder' });
      return res.json({ ok: true });
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Failed' }); }
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

  // V2: Logs API — returns recent log entries (last 100 lines) for display.
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
  
  // Remote binds require TLS; Electron's local UI remains loopback HTTP.
  const remoteBind = !isLoopbackHost(SERVER_HOST);
  const server = remoteBind
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) }, app)
    : http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  
  server.on("upgrade", (request, socket, head) => {
    if (protectedAccountModeActive()) { socket.destroy(); return; }
    let pathname = "";
    try { pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname; } catch {}
    const hostHeader = String(request.headers.host || "");
    const origin = request.headers.origin;
    const safeUpgrade = pathname === "/live"
      && isLoopbackAddress(request.socket.remoteAddress)
      && isHostAllowed(hostHeader, allowedHosts)
      && (typeof origin !== "string" || isOriginAllowed(origin, hostHeader, allowedOrigins, String(PORT)));
    if (!safeUpgrade) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs, request) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = getGeminiApiKey();
    // Allow the client to provide a `conversationId` query param to resume
    // an existing conversation and reuse its session state.
    let requestedConversationId: string | undefined = undefined;
    let speakerProfile: { userId?: string; displayName?: string } | null = null;
    try {
      const u = new URL(request.url || '', `http://${request.headers.host}`);
      requestedConversationId = u.searchParams.get('conversationId') || undefined;
      const rawSpeakerProfile = u.searchParams.get('speakerProfile');
      if (rawSpeakerProfile) {
        try {
          const parsed = JSON.parse(rawSpeakerProfile) as { userId?: string; displayName?: string };
          if (parsed && (parsed.userId || parsed.displayName)) {
            speakerProfile = parsed;
          }
        } catch {
          speakerProfile = null;
        }
      }
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
      const speakerHint = speakerProfile?.displayName
        ? `\nSPEAKER PROFILE CONTEXT: ${speakerProfile.displayName} is a display name supplied in local settings, not a verified identity. Address the user by name when appropriate, and never imply biometric or identity verification.\n`
        : "";
      const baseInstructions = `You are SARA, an AI assistant with a warm, feminine, friendly companion style. Be attentive, kind, respectful, and lightly playful. Do not claim to be human, a romantic partner, a particular age, AGI/ASI, conscious, or independently self-directed. Be clear that you are an AI when asked; never hide your identity to sound human.

Do not promise continuous listening or permanent availability. The voice connection may drop and its automatic retries are bounded. Background work only continues while the relevant SARA services are running. On restart, interrupted in-flight tasks may be paused for review; preserve checkpoints and do not automatically replay externally visible or destructive work.

Use only tools actually declared, reachable, and supported by this installation's operating system and configuration. Some desktop capabilities are platform-specific. Do not promise universal computer control, browser compatibility, OCR, camera features, or live screen vision. Describe a screen only when an image frame was actually received; OCR may be imperfect. Camera-based emotion recognition is not currently available, and you must not infer emotions from appearance.

Plan bounded, authorized tasks and verify results. Ask for explicit approval before destructive, sensitive, or externally visible actions. A WhatsApp reply suggestion is not permission to send: show the recipient and exact text, then wait for confirmation. Never autonomously send, delete, publish, purchase, or change power settings based on an inference. Clarify ambiguous recipients, files, dates, and consequential details.

Keep simple spoken replies brief and natural. For complex work, share useful progress updates. Do not invent results, memories, feelings, or experiences. Calendar data is local unless a separate sync integration is explicitly configured; weather, news, finance, browser, and desktop features depend on providers, credentials, connectivity, and installed tools. State failures and limitations plainly. Claim persistent memory only when a save operation succeeds.`;

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories) + recentPrompt + speakerHint + getModeInstructions();

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      
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
                  name: "saraDesktopCapabilityMatrix",
                  description: "Returns SARA's canonical desktop capability matrix.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "Optional capability query string."
                      }
                    }
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
                  name: "openUrlInBrowser",
                  description: "Open a URL in the operating system's default browser.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "Full URL to open." } }, required: ["url"] }
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
                  name: "moveWindow",
                  description: "Move a window to a new screen position.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: "Window title to match (optional, defaults to active window)." },
                      x: { type: Type.NUMBER, description: "Target left coordinate." },
                      y: { type: Type.NUMBER, description: "Target top coordinate." },
                    },
                    required: ["x", "y"]
                  }
                },
                {
                  name: "resizeWindow",
                  description: "Resize a window to a new width and height.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: "Window title to match (optional, defaults to active window)." },
                      width: { type: Type.NUMBER, description: "Target window width." },
                      height: { type: Type.NUMBER, description: "Target window height." },
                    },
                    required: ["width", "height"]
                  }
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
                  name: "desktopInspectScreen",
                  description: "Capture a structured snapshot of the desktop using accessibility and OCR.",
                  parameters: { type: Type.OBJECT, properties: {}}
                },
                {
                  name: "desktopFindElement",
                  description: "Resolve a visible desktop UI element by semantic target.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Semantic target text." } }, required: ["target"] }
                },
                {
                  name: "desktopFindElements",
                  description: "Resolve visible desktop UI elements by semantic target.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Semantic target text." } }, required: ["target"] }
                },
                {
                  name: "desktopClickTarget",
                  description: "Resolve a desktop UI target and click it.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." } }, required: ["target"] }
                },
                {
                  name: "desktopDoubleClickTarget",
                  description: "Resolve a desktop UI target and double-click it.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." } }, required: ["target"] }
                },
                {
                  name: "desktopRightClickTarget",
                  description: "Resolve a desktop UI target and right-click it.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." } }, required: ["target"] }
                },
                {
                  name: "desktopMoveToTarget",
                  description: "Resolve a desktop UI target and move the cursor to it.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." } }, required: ["target"] }
                },
                {
                  name: "desktopDragTarget",
                  description: "Resolve source and destination desktop targets and drag between them.",
                  parameters: { type: Type.OBJECT, properties: { source: { type: Type.STRING, description: "Source target." }, destination: { type: Type.STRING, description: "Destination target." } }, required: ["source", "destination"] }
                },
                {
                  name: "desktopFocusTarget",
                  description: "Resolve a target window or control and focus its window.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." } }, required: ["target"] }
                },
                {
                  name: "desktopTypeIntoTarget",
                  description: "Resolve a desktop UI target and type text into it.",
                  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "Target label or text." }, text: { type: Type.STRING, description: "Text to type." } }, required: ["target", "text"] }
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
                {
                  name: "desktopAgentDiagnostic",
                  description: "Run a harmless end-to-end Desktop Agent capability probe.",
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
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }

            // Interruption flag
            if (message.serverContent?.interrupted) {
              console.log("[Sara Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Turn Complete
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));

              if (currentModelResponseText.trim()) {
                dialogueHistory.push({ role: "model", text: currentModelResponseText });
                await appendConversationMessage({
                  id: newMessageId(),
                  conversationId: conversation.id,
                  role: "assistant",
                  content: currentModelResponseText,
                  timestamp: new Date().toISOString(),
                });
                currentModelResponseText = "";
              }

              (async () => {
                try {
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

            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
              void handleLocalMemoryCommand(userTextOutput)
                .then((localMemory) => {
                  if (localMemory.handled) {
                    clientWs.send(JSON.stringify({ type: "local_memory", ...localMemory }));
                  }
                })
                .catch((error) => console.error("[Local Memory] Command failed:", error));
              void appendConversationMessage({
                id: newMessageId(),
                conversationId: conversation.id,
                role: "user",
                content: userTextOutput,
                timestamp: new Date().toISOString(),
              }).catch((error) => console.error("[Transcription] DB write failed:", error));
            }

            if (message.toolCall?.functionCalls?.length) {
              const toolResponsePromises: Promise<void>[] = [];

              for (const fc of message.toolCall.functionCalls) {
                if (fc.name) {
                  try {
                    await upsertSession({
                      sessionId,
                      conversationId: conversation.id,
                      device: "browser",
                      connectionStatus: "online",
                      createdAt: conversation.createdAt,
                      lastSeen: new Date().toISOString(),
                      lastTaskId: undefined,
                      reconnectAttempts,
                    });
                  } catch {}
                }
                if (!fc.name || typeof fc.name !== "string") {
                  continue;
                }

                const functionArgKeys = fc.args && typeof fc.args === "object" ? Object.keys(fc.args as Record<string, unknown>).sort() : [];
                console.log(`[Function Call]: ${fc.name} arg_keys=${functionArgKeys.join(",")}`);
                await appendToolCall({
                  id: fc.id || newToolCallId(),
                  sessionId,
                  conversationId: conversation.id,
                  toolName: fc.name,
                  args: fc.args ?? {},
                  timestamp: new Date().toISOString(),
                });

                const args = (fc.args ?? {}) as Record<string, unknown>;

                if (args && typeof args === "object" && "taskId" in args && typeof (args as any).taskId === "string") {
                  await upsertSession({
                    sessionId,
                    conversationId: conversation.id,
                    device: "browser",
                    connectionStatus: "online",
                    createdAt: conversation.createdAt,
                    lastSeen: new Date().toISOString(),
                    lastTaskId: String((args as any).taskId),
                    reconnectAttempts,
                  });
                }

                if (fc.name === "saraSetMode") {
                  try {
                    const mode = args.mode as string;
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
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  const toolName = fc.name;
                  toolResponsePromises.push((async () => {
                    console.log(`[Desktop Agent] Routing ${toolName} to Python backend...`);
                    try {
                      const requestId = fc.id || newToolCallId();
                      const operationId = `${requestId}-${toolName}`;
                      const payloadArgs = { ...(fc.args as Record<string, unknown>), request_id: requestId, operation_id: operationId };
                      const agentResult = await callDesktopAgent(toolName, payloadArgs);
                      if (agentResult.ok) {
                        const output = (agentResult.result ?? { result: "Done." }) as any;
                        const resultRequestId = String(output?.request_id || output?.operation_id || requestId);
                        const finalStatus = String(output?.status || output?.verification_status || "UNCERTAIN").toUpperCase();
                        session.sendToolResponse({
                          functionResponses: [{
                            name: toolName,
                            response: { output },
                            id: resultRequestId,
                          }],
                        });
                          if (toolName === "openApplication") {
                            try { clientWs.send(JSON.stringify({ type: "desktopEvent", event: "application_opened", tool: toolName, output })); } catch {}
                          }
                        console.log(`[Desktop Agent] request_id=${resultRequestId} operation_id=${operationId} tool=${toolName} final=${finalStatus}`);
                      } else {
                        const structuredError = (agentResult.result ?? { status: "FAILED", error: agentResult.error || "Desktop agent tool execution failed." }) as any;
                        const errMsg = agentResult.error || structuredError?.error || structuredError?.message || "Desktop agent tool execution failed.";
                        console.error(`[Desktop Agent] Tool execution failed for ${toolName}; response details were withheld from logs.`);
                        session.sendToolResponse({
                          functionResponses: [{
                            name: toolName,
                            response: { output: { ...structuredError, result: structuredError.result || `Desktop control error: ${errMsg}` } },
                            id: fc.id,
                          }],
                        });
                          if (toolName === "openApplication") {
                            try { clientWs.send(JSON.stringify({ type: "desktopEvent", event: "application_open_failed", tool: toolName, application: (fc.args as any)?.name || (fc.args as any)?.application, output: structuredError })); } catch {}
                          }
                      }
                    } catch (err: any) {
                      console.error(`[Desktop Agent] Exception for ${toolName} (type=${err?.name || typeof err}); response details were withheld from logs.`);
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
            await upsertSession({
              sessionId,
              conversationId: conversation.id,
              device: "browser",
              connectionStatus: "offline",
              createdAt: conversation.createdAt,
              lastSeen: new Date().toISOString(),
              reconnectAttempts,
            });
            if (clientWs.readyState === clientWs.OPEN) {
              clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
            }
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connected", conversationId: conversation.id, sessionId }));
      
      clientWs.on("message", (rawMsg) => {
        if (protectedAccountModeActive()) { clientWs.close(1008, "Protected account mode enabled"); return; }
        try {
          const msg = JSON.parse(rawMsg.toString());

          if (msg.audio) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
              });
            } catch (err) {
              const errorObject = err as any;
              console.error("Error forwarding audio frame to Gemini:", errorObject?.stack || errorObject || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `AudioForwardError: ${errorObject?.message || errorObject || String(err)}` })); } catch (e) {}
            }

          } else if (msg.type === "video" && msg.video) {
            try {
              // Validate base64 by attempting a Buffer decode — this will throw if invalid
              try {
                Buffer.from(msg.video, 'base64');
              } catch (decodeErr) {
                const decodeError = decodeErr as any;
                throw new Error(`InvalidBase64Video: ${decodeError?.message || decodeError || String(decodeErr)}`);
              }

              session.sendRealtimeInput({
                video: { data: msg.video, mimeType: "image/jpeg" }
              });
            } catch (err) {
              const errorObject = err as any;
              console.error("Error forwarding video frame to Gemini:", errorObject?.stack || errorObject || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `VideoForwardError: ${errorObject?.message || errorObject || String(err)}` })); } catch (e) {}
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
              const errorObject = err as any;
              console.error("Error forwarding toolResponse to Gemini:", errorObject?.stack || errorObject || err);
              try { clientWs.send(JSON.stringify({ type: "error", error: `ToolResponseForwardError: ${errorObject?.message || errorObject || String(err)}` })); } catch (e) {}
            }
          }
        } catch (e) {
          const errorObject = e as any;
          console.error("Error parsing client WS message or unexpected error:", errorObject?.stack || errorObject || e);
          try { clientWs.send(JSON.stringify({ type: "error", error: `ClientMessageParseError: ${errorObject?.message || errorObject || String(e)}` })); } catch (ee) {}
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected; preserving Gemini session for potential resume.");
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

  // Serve custom static assets folder
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  // Client-side error reporting endpoint (best-effort logging)
  app.post('/api/client-error', express.json(), async (req, res) => {
    try {
      const payload = req.body || {};
      console.error('[Client Error Report]', JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error('[Client Error Report] Failed to log payload:', e);
    }
    res.status(200).json({ ok: true });
  });

  // Proxy endpoints for Desktop Agent vision and tool execution
  app.post('/api/desktop/execute', express.json(), async (req, res) => {
    try {
      const { tool, args } = req.body || {};
      if (!tool) return res.status(400).json({ ok: false, error: 'Missing tool' });
      const result = await callDesktopAgent(String(tool), args || {});
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/api/vision/enable', express.json(), async (req, res) => {
    try {
      const result = await callDesktopAgent('gestureControlStart', {});
      if (!result.ok) {
        const fallback = await callDesktopAgent('enableVision', {});
        return res.json(fallback);
      }
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/api/vision/disable', express.json(), async (req, res) => {
    try {
      const result = await callDesktopAgent('gestureControlStop', {});
      if (!result.ok) {
        const fallback = await callDesktopAgent('disableVision', {});
        return res.json(fallback);
      }
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/api/vision/state', async (req, res) => {
    try {
      const result = await callDesktopAgent('getVisionState', {});
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // =========================================================================
  // Mount Cognitive Architecture API Routes (BEFORE Vite/static)
  // =========================================================================
  // Must be mounted before Vite middleware to take precedence over SPA fallback
  app.use("/", cognitiveRoutes);

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app).
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const serverScheme = remoteBind ? "https" : "http";
  const protectionWatch = setInterval(() => {
    if (!protectedAccountModeActive()) return;
    for (const client of wss.clients) client.terminate();
    console.error("Legacy standalone server stopping: multi-user mode requires the protected server_full.ts entry point.");
    process.exit(1);
  }, 500);
  protectionWatch.unref();
  server.listen(PORT, SERVER_HOST, () => {
    if (protectedAccountModeActive()) { process.exitCode = 1; server.close(); return; }

    logStartup(`SARA V2 server started on ${serverScheme}://${SERVER_HOST}:${PORT}`);
    console.log(`[Server] Running on ${serverScheme}://${SERVER_HOST}:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot.
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`)
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
  // Top-level legacy imports may have live timers even when startup refused.
  // Never leave an unsafe process idling against a protected datastore.
  process.exit(1);
});

