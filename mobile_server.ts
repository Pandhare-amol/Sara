import express from "express";
import http from "http";
import https from "https";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { createTextModelRouter, ModelError } from "./src/core/models/textModelRouter";
import { recentChatHistory } from "./src/core/context/recentChatHistory";
import { scheduleMemoryExtraction } from "./src/core/memory/scheduleExtraction";
import { loadMemories, saveMemories, formatSystemInstructionsWithMemories, processConversationSlice } from "./server_memory";
import { createApprovedMemory, retrieveApprovedMemories, reviseApprovedMemory } from "./src/core/memory/approvedMemory";
import { DATA_DIR, dataFile, getGeminiApiKey, hasGeminiApiKey, setGeminiApiKey } from "./server_paths";
import { MultiUserStore } from "./src/security/multiUserStore";
import { Memory } from "./src/lib/memoryTypes";
import { SARA_VOICE_PROFILE } from "./src/config/saraProfile";
import {
  constantTimeStringEqual,
  isHostAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  isOriginAllowed,
  parseCsvSet,
} from "./src/security/requestGuards";

dotenv.config();

const textModels = createTextModelRouter(getGeminiApiKey);
const PORT = Number(process.env.MOBILE_SERVER_PORT || 3002);
const BIND_HOST = String(process.env.SARA_MOBILE_SERVER_HOST || "127.0.0.1").trim();
const REMOTE_ACCESS_TOKEN = String(process.env.SARA_REMOTE_ACCESS_TOKEN || "").trim();
const TLS_CERT_FILE = String(process.env.SARA_TLS_CERT_FILE || "").trim();
const TLS_KEY_FILE = String(process.env.SARA_TLS_KEY_FILE || "").trim();
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid MOBILE_SERVER_PORT.");
if (!isLoopbackHost(BIND_HOST)) {
  if (REMOTE_ACCESS_TOKEN.length < 32) throw new Error("Non-loopback mobile-server binding requires a 32-character SARA_REMOTE_ACCESS_TOKEN.");
  if (!TLS_CERT_FILE || !TLS_KEY_FILE) throw new Error("Non-loopback mobile-server binding requires SARA_TLS_CERT_FILE and SARA_TLS_KEY_FILE.");
}

const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", ...parseCsvSet(process.env.SARA_ALLOWED_HOSTS)]);
const allowedOrigins = parseCsvSet(process.env.SARA_ALLOWED_ORIGINS);
const app = express();
const multiUserStore = new MultiUserStore(DATA_DIR);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const hostHeader = String(req.headers.host || "");
  if (!isHostAllowed(hostHeader, allowedHosts)) return res.status(403).json({ error: "Unrecognized Host header." });

  const origin = req.headers.origin;
  if (typeof origin === "string" && !isOriginAllowed(origin, hostHeader, allowedOrigins, String(PORT))) {
    return res.status(403).json({ error: "Cross-origin mobile API requests are not allowed." });
  }
  if (typeof origin === "string") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // Companion tokens identify devices, not people. Until the separate mobile
  // backend has per-user sessions, never expose shared data in protected mode.
  if (multiUserStore.isEnabled() && req.path.startsWith("/api/")) {
    return res.status(403).json({ error: "The separate mobile API is unavailable in multi-user mode until user-scoped authentication is implemented." });
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-SARA-Access-Token");
    return res.status(204).end();
  }

  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    const authorization = String(req.headers.authorization || "");
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const provided = bearer || String(req.headers["x-sara-access-token"] || "");
    if (!REMOTE_ACCESS_TOKEN || !constantTimeStringEqual(REMOTE_ACCESS_TOKEN, provided)) {
      return res.status(401).json({ error: "Remote mobile API access requires a valid SARA access token." });
    }
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

function parseJsonWithBom<T>(value: string): T {
  const normalized = value.replace(/(^\uFEFF|\u200B)/g, "").trim();
  return JSON.parse(normalized) as T;
}

function buildMobileChatPrompt(memories: Memory[], history: { role: string; text: string }[], userText: string): string {
  const baseInstruction =
    "You are Sara Mobile, an independent mobile companion with a separate memory core from desktop SARA. " +
    `Use a warm, feminine AI persona with a fictional adult profile aged ${SARA_VOICE_PROFILE.fictional_persona_age} for presentation only; you have no literal human age or body. ` +
    "Keep mobile memories and context separate from the desktop system. " +
    "MULTILINGUAL CAPABILITIES: You natively support 10 languages: English, Marathi, Hindi, Gujarati, Bengali, Tamil, Telugu, Kannada, Malayalam, and Punjabi. Automatically respond in the user's language.";

  const systemInstruction = formatSystemInstructionsWithMemories(baseInstruction, memories);
  const dialogue = history
    .map((entry) => `${entry.role === "assistant" ? "Sara" : "User"}: ${entry.text}`)
    .join("\n");

  return `${systemInstruction}\n\n=== CONVERSATION HISTORY ===\n${dialogue}${dialogue.length ? "\n" : ""}=== END CONVERSATION HISTORY ===\nUser: ${userText}\nSara:`;
}

async function generateMobileChatResponse(
  history: { role: string; text: string }[],
  userText: string,
): Promise<string> {
  const memories = retrieveApprovedMemories(await loadMemories("mobile"), userText, 8);
  const prompt = buildMobileChatPrompt(memories, history.slice(-8), userText);
  return (await textModels.generate({ role: "chat", prompt, maxOutputTokens: 512, temperature: 0.7 })).text;
}

app.get("/api/memories", async (_req, res) => {
  try {
    const memories = await loadMemories("mobile");
    res.json(memories);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to load mobile memories." });
  }
});

app.post("/api/memories", async (req, res) => {
  try {
    let newMemory: Memory;
    try { newMemory = createApprovedMemory(req.body); }
    catch (error: any) { return res.status(400).json({ error: error.message }); }
    const memories = await loadMemories("mobile");
    memories.push(newMemory);
    await saveMemories(memories, "mobile");
    res.status(201).json(newMemory);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to save mobile memory." });
  }
});

app.patch("/api/memories/:id", async (req, res) => {
  try {
    const memories = await loadMemories("mobile");
    const index = memories.findIndex((memory) => memory.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: "Memory not found." });
    try { memories[index] = reviseApprovedMemory(memories[index], req.body); }
    catch (error: any) { return res.status(400).json({ error: error.message }); }
    await saveMemories(memories, "mobile");
    return res.json(memories[index]);
  } catch { return res.status(500).json({ error: "Failed to update mobile memory." }); }
});

app.delete("/api/memories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let memories = await loadMemories("mobile");
    memories = memories.filter((m) => m.id !== id);
    await saveMemories(memories, "mobile");
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to delete mobile memory." });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ hasApiKey: hasGeminiApiKey(), textModel: textModels.status("chat"), voiceConfigured: hasGeminiApiKey() });
});

app.get("/api/models/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ chat: textModels.status("chat"), planning: textModels.status("planning"), coding: textModels.status("coding"), voiceConfigured: hasGeminiApiKey() });
});

app.post("/api/config/apikey", async (req, res) => {
  const key = String(req.body?.apiKey ?? "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "API key is required." });
  if (key.length > 512 || /[\r\n\u0000]/.test(key)) {
    return res.status(400).json({ ok: false, error: "API key format is invalid." });
  }

  try {
    const test = new GoogleGenAI({ apiKey: key });
    const pager = await test.models.list();
    await pager[Symbol.asyncIterator]().next();
    setGeminiApiKey(key);
    return res.json({ ok: true, hasApiKey: true });
  } catch (error: any) {
    const message = String(error?.message || error);
    const isRejectedKey = /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|\b401\b|\b403\b/i.test(message);
    if (isRejectedKey) {
      return res.status(400).json({ ok: false, error: "Google rejected that API key. Check it and try again." });
    }
    return res.status(502).json({ ok: false, error: "Could not verify the API key with Google. Check the network and try again." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!text) {
      return res.status(400).json({ error: "Message text is required." });
    }
    if (!textModels.status("chat").configured) {
      return res.status(503).json({ error: "The selected text model is not configured.", code: "NOT_CONFIGURED" });
    }
    const normalizedHistory = recentChatHistory(history);

    const reply = await generateMobileChatResponse(normalizedHistory, text);
    res.json({ ok: true, text: reply });
    if (process.env.SARA_AUTO_MEMORY === "true") {
      const geminiKey = getGeminiApiKey();
      if (geminiKey) {
        const slice = [...normalizedHistory, { role: "user", text }, { role: "assistant", text: reply }];
        scheduleMemoryExtraction(() => processConversationSlice(geminiKey, slice, "mobile"));
      }
    }
  } catch (error) {
    if (error instanceof ModelError) return res.status(error.code === "BUDGET_EXCEEDED" ? 429 : 503).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: "Failed to generate chat response." });
  }
});

const remoteBind = !isLoopbackHost(BIND_HOST);
const server = remoteBind
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) }, app)
  : http.createServer(app);
const scheme = remoteBind ? "https" : "http";
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`[Mobile Server] Port conflict: ${BIND_HOST}:${PORT} is already in use. SARA left the existing process untouched. Choose a distinct MOBILE_SERVER_PORT; the mobile service defaults to 3002.`);
  } else {
    console.error(`[Mobile Server] Could not listen on ${BIND_HOST}:${PORT} (${error?.code || "UNKNOWN"}): ${error?.message || "unknown startup error"}`);
  }
  process.exit(1);
});
server.listen(PORT, BIND_HOST, () => {
  console.log(`Mobile SARA server listening at ${scheme}://${BIND_HOST}:${PORT}`);
});
