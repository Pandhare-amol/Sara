/**
 * Sara Playwright Local Agent Server
 * Run this locally on your machine to grant Sara real control over your browser!
 * 
 * Setup instructions:
 * 1. Make sure you have Node.js installed.
 * 2. In a clean folder on your local computer, create 'local-agent.js' pasting this content.
 * 3. Run: npm install playwright express dotenv
 * 4. Run: npx playwright install chromium
 * 5. Launch the server: node local-agent.js
 *
 * This service is restricted to loopback and exact local UI origins. It must not
 * be exposed to a LAN or public network.
 */

import express from "express";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const app = express();
const HOST = "127.0.0.1";
const PORT = Number(process.env.SARA_BROWSER_AGENT_PORT || 3001);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid SARA_BROWSER_AGENT_PORT: ${process.env.SARA_BROWSER_AGENT_PORT}`);
}
const allowedOrigins = new Set(
  (process.env.SARA_BROWSER_AGENT_ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),
);
const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  if (!isLoopbackAddress(req.socket.remoteAddress || "")) {
    return res.status(403).json({ error: "Browser agent accepts loopback connections only." });
  }
  try {
    const host = new URL(`http://${req.headers.host || ""}`);
    const hostname = host.hostname.replace(/^\[|\]$/g, "");
    if (!allowedHostnames.has(hostname) || host.port !== String(PORT)) {
      return res.status(403).json({ error: "Browser agent rejected this Host header." });
    }
  } catch {
    return res.status(403).json({ error: "Browser agent rejected this Host header." });
  }
  const origin = req.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Browser agent rejected this Origin." });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "256kb", type: "application/json" }));

// Main state references
let browser = null;
let context = null;
let page = null;
let isNavigating = false;
let lastActionStatus = "Standing by for connection...";
let logsList = [];

function logAndBroadcast(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const formattedLog = { 
    id: Math.random().toString(), 
    text: `[${timestamp}] ${message}`, 
    type 
  };
  console.log(`[${type.toUpperCase()}] ${message}`);
  logsList.push(formattedLog);
  if (logsList.length > 50) logsList.shift();
  lastActionStatus = message;
}

// Help ensure we have a running browser and active page
async function ensureBrowser() {
  if (!browser) {
    logAndBroadcast("Launching real Chromium headed browser...", "info");
    browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--no-sandbox"]
    });
    context = await browser.newContext({
      viewport: null // Uses natural size
    });
    page = await context.newPage();
    logAndBroadcast("Real Browser window spawned successfully.", "success");
  } else if (!page || page.isClosed()) {
    logAndBroadcast("Re-opening closed page tab...", "info");
    page = await context.newPage();
  }
}

// REST GET API status endpoint
app.get("/api/status", async (req, res) => {
  res.json({
    service: "sara-local-browser-agent",
    connected: true,
    browserActive: !!browser,
    lastAction: lastActionStatus,
    logs: logsList,
    currentUrl: page ? page.url() : "None"
  });
});

// REST POST execution endpoint
app.post("/api/action", async (req, res) => {
  const { type, args } = req.body;
  if (!type) {
    return res.status(400).json({ error: "Missing parameter 'type'" });
  }

  logAndBroadcast(`Invoking Local Playwright directive: ${type}`, "action");

  try {
    await ensureBrowser();

    switch (type) {
      case "browserOpen": {
        if (isNavigating) {
          return res.json({ result: "A page is already loading. Waiting for completion before opening a new destination." });
        }

        let destination = args.url || "https://google.com";
        // Contextual convenience mappings
        if (!destination.startsWith("http://") && !destination.startsWith("https://")) {
          if (destination.toLowerCase().includes("youtube") || destination.toLowerCase() === "youtube") {
            destination = "https://youtube.com";
          } else if (destination.toLowerCase().includes("google") || destination.toLowerCase() === "google") {
            destination = "https://google.com";
          } else {
            destination = `https://${destination}`;
          }
        }

        logAndBroadcast(`Navigating real browser to: ${destination}`, "info");
        try {
          isNavigating = true;
          if (page && page.url() === destination) {
            await page.bringToFront();
            logAndBroadcast("Destination already open in the current tab; reusing the active page.", "info");
          } else {
            await page.goto(destination, { waitUntil: "load", timeout: 30000 });
          }
        } finally {
          isNavigating = false;
        }
        
        // Auto bypass cookie dialog on YouTube if visible
        if (destination.includes("youtube.com")) {
          try {
            const consentBtn = page.locator('button:has-text("Reject all"), button:has-text("Accept all"), button:has-text("I agree")').first();
            if (await consentBtn.isVisible({ timeout: 1500 })) {
              logAndBroadcast("Intercepted cookie consent box. Dismissing dialog...", "info");
              await consentBtn.click();
            }
          } catch (err) {}
        }

        logAndBroadcast(`Successfully loaded: ${destination}`, "success");
        return res.json({ result: `Opened real browser and landed on ${destination}` });
      }

      case "browserSearch": {
        const query = args.query;
        if (!query) {
          throw new Error("Query parameters missing in action envelope.");
        }

        logAndBroadcast(`Searching for term: "${query}"`, "info");
        await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
        const currentUrl = page.url().toLowerCase();

        if (currentUrl.includes("youtube.com")) {
          const ytInput = page.locator('input[id="search"], input[name="search_query"]').first();
          await ytInput.waitFor({ state: "visible", timeout: 5000 });
          await ytInput.fill(query);
          await ytInput.press("Enter");
        } else if (currentUrl.includes("google.com")) {
          const googleInput = page.locator('textarea[name="q"], input[name="q"]').first();
          await googleInput.waitFor({ state: "visible", timeout: 5000 });
          await googleInput.fill(query);
          await googleInput.press("Enter");
        } else {
          // General input heuristic search
          const generalInput = page.locator('input[type="text"], input[type="search"]').first();
          await generalInput.fill(query);
          await generalInput.press("Enter");
        }

        logAndBroadcast(`Search query submitted for: "${query}"`, "success");
        return res.json({ result: `Successfully typed search query "${query}" and triggered event execution.` });
      }

      case "browserClick": {
        const selector = args.selector;
        const desc = args.description || selector;
        if (!selector) {
          throw new Error("Click request omitted mandatory selector path.");
        }

        logAndBroadcast(`Attempting targeted click on: "${desc}"`, "info");
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});

        // Specific high-level YouTube item redirection overrides
        if (selector.startsWith("video-")) {
          const videoId = selector.replace("video-", "");
          const directUrl = `https://www.youtube.com/watch?v=${videoId}`;
          logAndBroadcast(`YouTube direct link matching. Re-routing straight to: ${directUrl}`, "info");
          await page.goto(directUrl, { waitUntil: "load", timeout: 30000 });
          logAndBroadcast(`Video playback stream opened successfully.`, "success");
          return res.json({ result: `Loaded YouTube stream directly: ${directUrl}` });
        }

        // Standard clicking checks
        let clicked = false;
        
        // Robust YouTube list checking: find link holding matching search labels or items
        if (page.url().includes("youtube.com")) {
          // If trying to click the 'first' index or item from search:
          if (selector === "play-button") {
            await page.evaluate(() => { document.querySelector('video')?.play(); });
            clicked = true;
          } else if (selector === "pause-button") {
            await page.evaluate(() => { document.querySelector('video')?.pause(); });
            clicked = true;
          } else {
            // Find ytd-video-renderer search elements
            const firstResult = page.locator('ytd-video-renderer a#video-title, ytd-rich-grid-media a#video-title').first();
            if (await firstResult.isVisible({ timeout: 2000 })) {
              logAndBroadcast("Identified top organic video card. Executing click...", "info");
              await firstResult.click();
              clicked = true;
            }
          }
        }

        if (!clicked) {
          // Fallback to text matching or direct selector matching
          const textLocator = page.locator(`text="${selector}"`).first();
          if (await textLocator.isVisible({ timeout: 1500 })) {
            await textLocator.click();
            clicked = true;
          } else {
            const selectorLocator = page.locator(selector).first();
            await selectorLocator.click({ timeout: 3000 });
            clicked = true;
          }
        }

        logAndBroadcast(`Successful click completed on target.`, "success");
        return res.json({ result: "Click operation completed successfully." });
      }

      case "browserMediaControl": {
        const action = args.action;
        const val = args.value;
        logAndBroadcast(`Executing real media action: ${action}`, "info");

        let responseText = `Action ${action} completed on player.`;

        if (action === "play") {
          await page.evaluate(() => { document.querySelector('video')?.play(); });
        } else if (action === "pause") {
          await page.evaluate(() => { document.querySelector('video')?.pause(); });
        } else if (action === "volume") {
          const percent = val || 75;
          await page.evaluate((pct) => {
            const v = document.querySelector('video');
            if (v) v.volume = pct / 100;
          }, percent);
          responseText = `Adjusted volume level to ${percent}%`;
        } else if (action === "mute") {
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) v.muted = true;
          });
        } else if (action === "unmute") {
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) v.muted = false;
          });
        } else if (action === "fullscreen") {
          // YouTube native shortcut 'f' is extremely safe and fast
          await page.keyboard.press("f");
          responseText = "Toggled fullscreen view.";
        } else if (action === "exit_fullscreen") {
          await page.evaluate(() => {
            if (document.fullscreenElement) {
              document.exitFullscreen();
            }
          });
          responseText = "Exited fullscreen layout.";
        } else if (action === "skip") {
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) v.currentTime += 30;
          });
          responseText = "Skipped forward 30 seconds.";
        } else {
          throw new Error(`Media command action '${action}' unrecognized.`);
        }

        logAndBroadcast(`Media action completed: ${action}`, "success");
        return res.json({ result: responseText });
      }

      case "browserScroll": {
        const direction = args.direction || "down";
        const distance = args.amount || 400;
        const delta = direction === "down" ? distance : -distance;

        logAndBroadcast(`Scrolling document view vertical displacement: ${delta}px`, "info");
        await page.evaluate((yOffset) => {
          window.scrollBy({ top: yOffset, behavior: "smooth" });
        }, delta);

        logAndBroadcast(`Scroll action executed.`, "success");
        return res.json({ result: `Scrolled main layout ${direction} ${distance}px.` });
      }

      case "browserType": {
        const text = args.text;
        if (!text) throw new Error("Missing string 'text' in type container.");
        
        logAndBroadcast(`Typing text into input: "${text}"`, "info");
        await page.keyboard.type(text);
        
        logAndBroadcast(`Finished typing text.`, "success");
        return res.json({ result: `Typed text "${text}" inside the active element.` });
      }

      case "browserGoBack": {
        logAndBroadcast("Navigating back in page history...", "info");
        await page.goBack();
        logAndBroadcast("Returned to previous location.", "success");
        return res.json({ result: "Flashed browser history page back." });
      }

      case "browserTabAction": {
        const subAct = args.action;
        logAndBroadcast(`Browser tab request triggered: ${subAct}`, "info");

        if (subAct === "new") {
          if (isNavigating) {
            return res.json({ result: "A tab is already loading. Please wait for the current page load to finish before opening another tab." });
          }
          const startUrl = args.url || "https://google.com";
          const normalizedUrl = startUrl.startsWith("http") ? startUrl : `https://${startUrl}`;

          const existingPage = context.pages().find((p) => p.url() === normalizedUrl);
          if (existingPage) {
            page = existingPage;
            await page.bringToFront();
            logAndBroadcast(`Reused existing tab for ${normalizedUrl} instead of opening a duplicate tab.`, "info");
            return res.json({ result: `Switched to existing tab for ${normalizedUrl}.` });
          }

          isNavigating = true;
          try {
            page = await context.newPage();
            await page.goto(normalizedUrl, { waitUntil: "load", timeout: 30000 });
            logAndBroadcast(`New active tab loaded for: ${normalizedUrl}`, "success");
          } finally {
            isNavigating = false;
          }
        } else if (subAct === "close") {
          if (page) {
            await page.close();
          }
          const pages = context.pages();
          if (pages.length > 0) {
            page = pages[pages.length - 1];
            logAndBroadcast(`Active tab closed. Selected last open tab.`, "success");
          } else {
            page = null;
            logAndBroadcast(`All tabs closed. Waiting for new instructions.`, "info");
          }
        }
        return res.json({ result: `Tab command ${subAct} completed.` });
      }

      default:
        throw new Error(`Directive '${type}' not recognized by Sara's local Playwright engine.`);
    }

  } catch (err) {
    logAndBroadcast(`Execution error during operation: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

async function isSaraBrowserAgentAlreadyRunning() {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/api/status`, { signal: AbortSignal.timeout(800) });
    const status = await response.json();
    return response.ok && status?.service === "sara-local-browser-agent";
  } catch {
    return false;
  }
}

async function startServer() {
  if (await isSaraBrowserAgentAlreadyRunning()) {
    console.log(`[Browser Agent] An existing SARA browser agent is already healthy at http://${HOST}:${PORT}; not starting a duplicate.`);
    return;
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`Sara Playwright Local Agent Server Running`);
    console.log(`Listening on: http://${HOST}:${PORT}`);
    console.log(`Allowed UI origins: ${[...allowedOrigins].join(", ") || "none configured"}`);
    console.log(`======================================================\n`);
  });
  server.once("error", async (error) => {
    if (error?.code === "EADDRINUSE" && await isSaraBrowserAgentAlreadyRunning()) {
      console.log(`[Browser Agent] A healthy SARA browser agent is already running at http://${HOST}:${PORT}; not starting a duplicate.`);
      return;
    }
    if (error?.code === "EADDRINUSE") {
      console.error(`[Browser Agent] Port conflict: ${HOST}:${PORT} is occupied by another service. SARA left it untouched. Check SARA_BROWSER_AGENT_PORT or identify the listener before stopping anything.`);
    } else {
      console.error(`[Browser Agent] Failed to listen on ${HOST}:${PORT}: ${error?.message || error}`);
    }
    process.exitCode = 1;
  });
}

void startServer();

