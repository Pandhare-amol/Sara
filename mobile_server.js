"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var dotenv_1 = require("dotenv");
var genai_1 = require("@google/genai");
var server_memory_1 = require("./server_memory");
var server_paths_1 = require("./server_paths");
dotenv_1.default.config();
var PORT = Number(process.env.MOBILE_SERVER_PORT || 3001);
var app = (0, express_1.default)();
app.disable("x-powered-by");
app.use(express_1.default.json());
function parseJsonWithBom(value) {
    var normalized = value.replace(/(^\uFEFF|\u200B)/g, "").trim();
    return JSON.parse(normalized);
}
function buildMobileChatPrompt(memories, history, userText) {
    var baseInstruction = "You are Sara Mobile, an independent mobile companion with a separate memory core from desktop SARA. " +
        "Speak in a warm, gentle, and helpful mobile companion tone. Keep mobile memories and context separate from the desktop system.";
    var systemInstruction = (0, server_memory_1.formatSystemInstructionsWithMemories)(baseInstruction, memories);
    var dialogue = history
        .map(function (entry) { return "".concat(entry.role === "assistant" ? "Sara" : "User", ": ").concat(entry.text); })
        .join("\n");
    return "".concat(systemInstruction, "\n\n").concat(dialogue, "\nUser: ").concat(userText, "\nSara:");
}
function generateMobileChatResponse(apiKey, history, userText) {
    return __awaiter(this, void 0, void 0, function () {
        var ai, memories, prompt, response;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    ai = new genai_1.GoogleGenAI({
                        apiKey: apiKey,
                        httpOptions: {
                            headers: {
                                "User-Agent": "aistudio-build",
                            },
                        },
                    });
                    return [4 /*yield*/, (0, server_memory_1.loadMemories)("mobile")];
                case 1:
                    memories = _b.sent();
                    prompt = buildMobileChatPrompt(memories, history.slice(-8), userText);
                    return [4 /*yield*/, ai.models.generateContent({
                            model: "gemini-3.5-flash",
                            contents: prompt,
                            config: {
                                maxOutputTokens: 512,
                                temperature: 0.7,
                            },
                        })];
                case 2:
                    response = _b.sent();
                    return [2 /*return*/, String((_a = response.text) !== null && _a !== void 0 ? _a : "").trim()];
            }
        });
    });
}
app.get("/api/memories", function (_req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var memories, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, (0, server_memory_1.loadMemories)("mobile")];
            case 1:
                memories = _a.sent();
                res.json(memories);
                return [3 /*break*/, 3];
            case 2:
                error_1 = _a.sent();
                res.status(500).json({ error: error_1.message || "Failed to load mobile memories." });
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
app.post("/api/memories", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, category, text, memories, timestamp, newMemory, error_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _b.trys.push([0, 3, , 4]);
                _a = req.body, category = _a.category, text = _a.text;
                if (!category || !text) {
                    return [2 /*return*/, res.status(400).json({ error: "Category and text parameters are required." })];
                }
                return [4 /*yield*/, (0, server_memory_1.loadMemories)("mobile")];
            case 1:
                memories = _b.sent();
                timestamp = new Date().toISOString();
                newMemory = {
                    id: Math.random().toString(36).substring(2, 11),
                    category: category,
                    text: text,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                memories.push(newMemory);
                return [4 /*yield*/, (0, server_memory_1.saveMemories)(memories, "mobile")];
            case 2:
                _b.sent();
                res.status(201).json(newMemory);
                return [3 /*break*/, 4];
            case 3:
                error_2 = _b.sent();
                res.status(500).json({ error: error_2.message || "Failed to save mobile memory." });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
app.delete("/api/memories/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id_1, memories, error_3;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 3, , 4]);
                id_1 = req.params.id;
                return [4 /*yield*/, (0, server_memory_1.loadMemories)("mobile")];
            case 1:
                memories = _a.sent();
                memories = memories.filter(function (m) { return m.id !== id_1; });
                return [4 /*yield*/, (0, server_memory_1.saveMemories)(memories, "mobile")];
            case 2:
                _a.sent();
                res.json({ success: true });
                return [3 /*break*/, 4];
            case 3:
                error_3 = _a.sent();
                res.status(500).json({ error: error_3.message || "Failed to delete mobile memory." });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
app.get("/api/config", function (_req, res) {
    res.json({ hasApiKey: (0, server_paths_1.hasGeminiApiKey)() });
});
app.post("/api/config/apikey", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var key, test, pager, e_1, msg, isAuthError, error_4;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                _c.trys.push([0, 6, , 7]);
                key = String((_b = (_a = req.body) === null || _a === void 0 ? void 0 : _a.apiKey) !== null && _b !== void 0 ? _b : "").trim();
                if (!key) {
                    return [2 /*return*/, res.status(400).json({ error: "API key is required." })];
                }
                _c.label = 1;
            case 1:
                _c.trys.push([1, 4, , 5]);
                test = new genai_1.GoogleGenAI({ apiKey: key });
                return [4 /*yield*/, test.models.list()];
            case 2:
                pager = _c.sent();
                return [4 /*yield*/, pager[Symbol.asyncIterator]().next()];
            case 3:
                _c.sent();
                return [3 /*break*/, 5];
            case 4:
                e_1 = _c.sent();
                msg = String((e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || e_1);
                isAuthError = /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
                if (isAuthError) {
                    return [2 /*return*/, res.status(400).json({ error: "That key was rejected by Google. Check it and try again." })];
                }
                return [3 /*break*/, 5];
            case 5:
                (0, server_paths_1.setGeminiApiKey)(key);
                res.json({ ok: true, hasApiKey: true });
                return [3 /*break*/, 7];
            case 6:
                error_4 = _c.sent();
                res.status(500).json({ error: error_4.message || "Failed to save API key." });
                return [3 /*break*/, 7];
            case 7: return [2 /*return*/];
        }
    });
}); });
app.post("/api/chat", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var text, history_1, apiKey, normalizedHistory, reply, error_5;
    var _a, _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0:
                _d.trys.push([0, 2, , 3]);
                text = String((_b = (_a = req.body) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : "").trim();
                history_1 = Array.isArray((_c = req.body) === null || _c === void 0 ? void 0 : _c.history) ? req.body.history : [];
                if (!text) {
                    return [2 /*return*/, res.status(400).json({ error: "Message text is required." })];
                }
                apiKey = (0, server_paths_1.getGeminiApiKey)();
                if (!apiKey) {
                    return [2 /*return*/, res.status(500).json({ error: "Gemini API key is not configured." })];
                }
                normalizedHistory = history_1
                    .map(function (item) {
                    var _a;
                    return ({
                        role: item.role === "assistant" ? "assistant" : "user",
                        text: String((_a = item.text) !== null && _a !== void 0 ? _a : "").trim(),
                    });
                })
                    .filter(function (item) { return item.text.length > 0; });
                return [4 /*yield*/, generateMobileChatResponse(apiKey, normalizedHistory, text)];
            case 1:
                reply = _d.sent();
                res.json({ ok: true, text: reply });
                return [3 /*break*/, 3];
            case 2:
                error_5 = _d.sent();
                res.status(500).json({ error: error_5.message || "Failed to generate chat response." });
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
app.listen(PORT, "0.0.0.0", function () {
    console.log("Mobile SARA server listening at http://0.0.0.0:".concat(PORT));
});
