import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { loadMemories, saveMemories, formatSystemInstructionsWithMemories } from "./server_memory";
import { dataFile, getGeminiApiKey, hasGeminiApiKey, setGeminiApiKey } from "./server_paths";
import { Memory } from "./src/lib/memoryTypes";

dotenv.config();

const PORT = Number(process.env.MOBILE_SERVER_PORT || 3001);
const app = express();
app.disable("x-powered-by");
app.use(express.json());

function parseJsonWithBom<T>(value: string): T {
  const normalized = value.replace(/(^\uFEFF|\u200B)/g, "").trim();
  return JSON.parse(normalized) as T;
}

function buildMobileChatPrompt(memories: Memory[], history: { role: string; text: string }[], userText: string): string {
  const baseInstruction =
    "You are Sara Mobile, an independent mobile companion with a separate memory core from desktop SARA. " +
    "Speak in a warm, gentle, and helpful mobile companion tone. Keep mobile memories and context separate from the desktop system. " +
    "MULTILINGUAL CAPABILITIES: You natively support 10 languages: English, Marathi, Hindi, Gujarati, Bengali, Tamil, Telugu, Kannada, Malayalam, and Punjabi. Automatically respond in the user's language.";

  const systemInstruction = formatSystemInstructionsWithMemories(baseInstruction, memories);
  const dialogue = history
    .map((entry) => `${entry.role === "assistant" ? "Sara" : "User"}: ${entry.text}`)
    .join("\n");

  return `${systemInstruction}\n\n${dialogue}\nUser: ${userText}\nSara:`;
}

async function generateMobileChatResponse(
  apiKey: string,
  history: { role: string; text: string }[],
  userText: string,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const memories = await loadMemories("mobile");
  const prompt = buildMobileChatPrompt(memories, history.slice(-8), userText);
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
    const { category, text } = req.body;
    if (!category || !text) {
      return res.status(400).json({ error: "Category and text parameters are required." });
    }
    const memories = await loadMemories("mobile");
    const timestamp = new Date().toISOString();
    const newMemory: Memory = {
      id: Math.random().toString(36).substring(2, 11),
      category,
      text,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    memories.push(newMemory);
    await saveMemories(memories, "mobile");
    res.status(201).json(newMemory);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to save mobile memory." });
  }
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
  res.json({ hasApiKey: hasGeminiApiKey() });
});

app.post("/api/config/apikey", async (req, res) => {
  try {
    const key = String(req.body?.apiKey ?? "").trim();
    if (!key) {
      return res.status(400).json({ error: "API key is required." });
    }
    try {
      const test = new GoogleGenAI({ apiKey: key });
      const pager = await test.models.list();
      await pager[Symbol.asyncIterator]().next();
    } catch (e: any) {
      const msg = String(e?.message || e);
      const isAuthError = /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
      if (isAuthError) {
        return res.status(400).json({ error: "That key was rejected by Google. Check it and try again." });
      }
    }
    setGeminiApiKey(key);
    res.json({ ok: true, hasApiKey: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to save API key." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
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

    const reply = await generateMobileChatResponse(apiKey, normalizedHistory, text);
    res.json({ ok: true, text: reply });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to generate chat response." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile SARA server listening at http://0.0.0.0:${PORT}`);
});
