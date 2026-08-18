"use strict";
/**
 * SARA â€” path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets SARA_DATA_DIR to a
 * writable folder under %APPDATA%\SARA, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATA_DIR = void 0;
exports.dataFile = dataFile;
exports.getGeminiApiKey = getGeminiApiKey;
exports.hasGeminiApiKey = hasGeminiApiKey;
exports.setGeminiApiKey = setGeminiApiKey;
exports.clearGeminiApiKey = clearGeminiApiKey;
var fs_1 = require("fs");
var path_1 = require("path");
/** Writable per-user data directory.
 *
 * In production this is controlled by SARA_DATA_DIR and points to the user
 * data folder (e.g. %APPDATA%/Sara). In development, keep writable runtime data
 * in a dedicated ./data directory so file watchers on the project root do not
 * trigger frontend reloads when the app writes memories, sessions, or settings.
 */
exports.DATA_DIR = process.env.SARA_DATA_DIR || path_1.default.join(process.cwd(), "data");
try {
    fs_1.default.mkdirSync(exports.DATA_DIR, { recursive: true });
}
catch (_a) {
    /* already exists / best-effort */
}
/** Absolute path to a file inside the writable data directory. */
function dataFile(name) {
    return path_1.default.join(exports.DATA_DIR, name);
}
// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the data dir).
// ---------------------------------------------------------------------------
var SECRETS_FILE = dataFile("secrets.json");
function readSecrets() {
    try {
        if (fs_1.default.existsSync(SECRETS_FILE)) {
            return JSON.parse(fs_1.default.readFileSync(SECRETS_FILE, "utf-8"));
        }
    }
    catch (_a) {
        /* corrupt â€” treat as empty */
    }
    return {};
}
/**
 * Resolve the active Gemini API key.
 * Priority: user-entered key (secrets.json) â†’ environment (.env, dev only).
 */
function getGeminiApiKey() {
    var _a, _b;
    var stored = (_a = readSecrets().geminiApiKey) === null || _a === void 0 ? void 0 : _a.trim();
    if (stored)
        return stored;
    var env = (_b = process.env.GEMINI_API_KEY) === null || _b === void 0 ? void 0 : _b.trim();
    return env || undefined;
}
/** Whether any usable key is configured (without revealing it). */
function hasGeminiApiKey() {
    return Boolean(getGeminiApiKey());
}
/** Persist a user-supplied key to the per-user secrets file. */
function setGeminiApiKey(key) {
    var trimmed = (key || "").trim();
    if (!trimmed)
        throw new Error("API key must not be empty.");
    var current = readSecrets();
    current.geminiApiKey = trimmed;
    fs_1.default.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
    try {
        fs_1.default.chmodSync(SECRETS_FILE, 384); // owner-only where supported
    }
    catch (_a) {
        /* Windows ACLs differ; best-effort */
    }
}
/** Remove the stored key (used by "reset"/sign-out flows). */
function clearGeminiApiKey() {
    var current = readSecrets();
    delete current.geminiApiKey;
    try {
        fs_1.default.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
    }
    catch (_a) {
        /* best-effort */
    }
}
