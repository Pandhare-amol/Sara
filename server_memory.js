"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMemories = loadMemories;
exports.saveMemories = saveMemories;
exports.formatSystemInstructionsWithMemories = formatSystemInstructionsWithMemories;
exports.processConversationSlice = processConversationSlice;
var promises_1 = require("fs/promises");
var genai_1 = require("@google/genai");
var server_paths_1 = require("./server_paths");
var DESKTOP_MEMORY_FILE = (0, server_paths_1.dataFile)("memories.json");
var MOBILE_MEMORY_FILE = (0, server_paths_1.dataFile)("memories_mobile.json");
function memoryFileForSource(source) {
    return source === "mobile" ? MOBILE_MEMORY_FILE : DESKTOP_MEMORY_FILE;
}
function parseJsonWithBom(value) {
    var normalized = value.replace(/^\uFEFF/, "").trim();
    return JSON.parse(normalized);
}
// Safe file operations with fallback
function loadMemories() {
    return __awaiter(this, arguments, void 0, function (source) {
        var filePath, data, error_1;
        if (source === void 0) { source = "desktop"; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    filePath = memoryFileForSource(source);
                    return [4 /*yield*/, promises_1.default.readFile(filePath, "utf-8")];
                case 1:
                    data = _a.sent();
                    return [2 /*return*/, parseJsonWithBom(data)];
                case 2:
                    error_1 = _a.sent();
                    // If file doesn't exist, return empty array
                    if (error_1.code === "ENOENT") {
                        return [2 /*return*/, []];
                    }
                    console.error("[Memory] Error loading memories, returning fallback:", error_1);
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function saveMemories(memories_1) {
    return __awaiter(this, arguments, void 0, function (memories, source) {
        var filePath, error_2;
        if (source === void 0) { source = "desktop"; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    filePath = memoryFileForSource(source);
                    return [4 /*yield*/, promises_1.default.writeFile(filePath, JSON.stringify(memories, null, 2), "utf-8")];
                case 1:
                    _a.sent();
                    console.log("[Memory] Saved ".concat(memories.length, " memories successfully (").concat(source, ")."));
                    return [3 /*break*/, 3];
                case 2:
                    error_2 = _a.sent();
                    console.error("[Memory] Error writing memory file:", error_2);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// Format memory core to system instruction injections
function formatSystemInstructionsWithMemories(baseInstruction, memories) {
    if (memories.length === 0) {
        return baseInstruction +
            "\n\n" +
            "=== SARA MEMORY CORE ===\n" +
            "You do not possess any historic recollections of this companion yet. " +
            "As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n" +
            "=========================\n";
    }
    // Group by category
    var grouped = {};
    memories.forEach(function (m) {
        grouped[m.category] = grouped[m.category] || [];
        grouped[m.category].push(m.text);
    });
    var memoryBlock = "\n\n" +
        "=== SARA PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\n" +
        "You have spoken with this user for a long duration. Below are your persistent recollections of who they are.\n" +
        "CRITICAL BRAND AND COGNITIVE PRINCIPLES:\n" +
        "- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my memory files...', 'My recollection database indicates...', or 'As you told me on June 12th...'. Instead, speak of these details casually and supportively as a true friend would (e.g. 'Oh, since you're working on that website project...', 'I hope you're keeping up with your YouTube channel goals too!').\n" +
        "- COMPANIONSHIP DEPTH: Allow your witty and responsive personality to adapt with empathy, based on their goals, life events, emotional milestones, and preferences.\n\n" +
        "CURRENT PERSISTENT KNOWLEDGE CARD:\n";
    var categoriesOrdered = [
        { key: "identity", label: "Identity (Name, nick, profession, background)" },
        { key: "preference", label: "Preferences & Tastes (Likes, dislikes, games, movies)" },
        { key: "goal", label: "Active Goals & Aspirations" },
        { key: "project", label: "Ongoing Projects & Ecosystems" },
        { key: "relationship", label: "Key People & Relationships mentioned" },
        { key: "emotional", label: "Emotional Highlights & Core Milestones" },
        { key: "behavior", label: "Observed Traits & Behavioral Tendencies" },
    ];
    categoriesOrdered.forEach(function (cat) {
        var list = grouped[cat.key] || [];
        if (list.length > 0) {
            memoryBlock += "* ".concat(cat.label, ":\n") + list.map(function (t) { return "  - ".concat(t); }).join("\n") + "\n";
        }
    });
    memoryBlock += "====================================================\n";
    return baseInstruction + memoryBlock;
}
// Background memory consolidation queue lock
var isConsolidating = false;
function processConversationSlice(apiKey, dialogueHistory) {
    return __awaiter(this, void 0, void 0, function () {
        var ai, currentMemories, memoryContext, dialogueContext, prompt_1, response, resultText, resultObj, transactions, updatedMemories, timestamp, _loop_1, _i, transactions_1, trx, error_3;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (isConsolidating) {
                        console.log("[Memory] Consolidation loop busy, skipping slice processing");
                        return [2 /*return*/, null];
                    }
                    if (dialogueHistory.length < 2) {
                        return [2 /*return*/, null];
                    }
                    isConsolidating = true;
                    console.log("[Memory] Initiating pipeline for dialogue slice of length:", dialogueHistory.length);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 5, , 6]);
                    ai = new genai_1.GoogleGenAI({
                        apiKey: apiKey,
                        httpOptions: {
                            headers: {
                                "User-Agent": "aistudio-build",
                            }
                        }
                    });
                    return [4 /*yield*/, loadMemories()];
                case 2:
                    currentMemories = _b.sent();
                    memoryContext = currentMemories.map(function (m) { return "ID: ".concat(m.id, " | Category: ").concat(m.category, " | Fact: ").concat(m.text); }).join("\n");
                    dialogueContext = dialogueHistory.map(function (line) { return "".concat(line.role === "user" ? "User" : "Sara", ": ").concat(line.text); }).join("\n");
                    prompt_1 = "You are Sara's deep cognitive recollection engine. Your task is to analyze the recent conversation piece against previous persistent memories, and output precise update transactions.\n\n### OBJECTIVE\nDecide if any statements contain durable, important personal facts, enduring preferences, aspirations, ongoing projects, critical relationships, key historical emotional events, or behavioral trends.\nAvoid cataloging small talk, greetings, general chit-chat, or fleeting sentences (e.g., ignore 'hello', 'how are you', 'waking up', 'lol').\n\n### CURRENT USER MEMORIES:\n".concat(memoryContext || "(No memory records exist)", "\n\n### RECENT DIALOGUE SLICE:\n").concat(dialogueContext, "\n\n### RULES\n- ACTIONS:\n  - \"ADD\": If new material information is introduced (e.g. user says 'My favorite food is lasagna' and it's not present).\n  - \"UPDATE\": If previous information has evolved or is corrected (e.g. user says 'I changed my major to computer science' when memory says they study history). Provide the exact ID of the memory to replace.\n  - \"REMOVE\": If a memory was explicitly disproven or the user directly asked Sara to forget it.\n- TEXT STYLE: Express the memories as clean, concise, third-person declarative summaries (e.g., 'The user is building a startup named Sara.', 'The user loves playing GTA 6.', 'The user enjoys technical and fast-paced styling explanations.'). Do not include conversational filler, quotes, or timestamps.\n- ID: For ADD, leave blank. For UPDATE or REMOVE, provide the exact 'id' from the \"Current user memories\" list.");
                    return [4 /*yield*/, ai.models.generateContent({
                            model: "gemini-3.5-flash",
                            contents: prompt_1,
                            config: {
                                responseMimeType: "application/json",
                                responseSchema: {
                                    type: genai_1.Type.OBJECT,
                                    properties: {
                                        transactions: {
                                            type: genai_1.Type.ARRAY,
                                            items: {
                                                type: genai_1.Type.OBJECT,
                                                properties: {
                                                    action: {
                                                        type: genai_1.Type.STRING,
                                                        description: "ADD, UPDATE, or REMOVE transaction.",
                                                        enum: ["ADD", "UPDATE", "REMOVE"]
                                                    },
                                                    id: {
                                                        type: genai_1.Type.STRING,
                                                        description: "Specific ID of the existing memory being modified or deleted (leave blank/null for ADD)."
                                                    },
                                                    category: {
                                                        type: genai_1.Type.STRING,
                                                        description: "The Memory category classification.",
                                                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                                                    },
                                                    text: {
                                                        type: genai_1.Type.STRING,
                                                        description: "The memory summarized as a concise declarative statement in third-person."
                                                    }
                                                },
                                                required: ["action", "category", "text"]
                                            }
                                        }
                                    },
                                    required: ["transactions"]
                                }
                            }
                        })];
                case 3:
                    response = _b.sent();
                    resultText = ((_a = response.text) === null || _a === void 0 ? void 0 : _a.trim()) || "{}";
                    resultObj = JSON.parse(resultText);
                    transactions = resultObj.transactions || [];
                    if (transactions.length === 0) {
                        console.log("[Memory] Zero transactions generated. Ignored routine conversations.");
                        isConsolidating = false;
                        return [2 /*return*/, null];
                    }
                    console.log("[Memory] Processing ".concat(transactions.length, " memory updates:"), JSON.stringify(transactions));
                    updatedMemories = __spreadArray([], currentMemories, true);
                    timestamp = new Date().toISOString();
                    _loop_1 = function (trx) {
                        if (trx.action === "ADD") {
                            var newMemory = {
                                id: Math.random().toString(36).substring(2, 11),
                                category: trx.category,
                                text: trx.text,
                                createdAt: timestamp,
                                updatedAt: timestamp
                            };
                            updatedMemories.push(newMemory);
                        }
                        else if (trx.action === "UPDATE") {
                            var tarIndex = updatedMemories.findIndex(function (m) { return m.id === trx.id; });
                            if (tarIndex !== -1) {
                                updatedMemories[tarIndex] = __assign(__assign({}, updatedMemories[tarIndex]), { category: trx.category, text: trx.text, updatedAt: timestamp });
                            }
                            else {
                                // Fallback, treat as ADD if ID not matched
                                var newMemory = {
                                    id: Math.random().toString(36).substring(2, 11),
                                    category: trx.category,
                                    text: trx.text,
                                    createdAt: timestamp,
                                    updatedAt: timestamp
                                };
                                updatedMemories.push(newMemory);
                            }
                        }
                        else if (trx.action === "REMOVE") {
                            updatedMemories = updatedMemories.filter(function (m) { return m.id !== trx.id; });
                        }
                    };
                    for (_i = 0, transactions_1 = transactions; _i < transactions_1.length; _i++) {
                        trx = transactions_1[_i];
                        _loop_1(trx);
                    }
                    return [4 /*yield*/, saveMemories(updatedMemories)];
                case 4:
                    _b.sent();
                    isConsolidating = false;
                    return [2 /*return*/, updatedMemories];
                case 5:
                    error_3 = _b.sent();
                    console.error("[Memory] Consolidation failure:", error_3);
                    isConsolidating = false;
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
