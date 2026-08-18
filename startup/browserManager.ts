/**
 * SARA Browser Configuration & Management
 *
 * Handles browser preferences and real browser launching for:
 * - YouTube playback
 * - Google Search
 * - General web browsing
 * - Automation vs. real browser distinction
 *
 * SARA supports two modes:
 * 1. REAL_BROWSER: Uses OS default or configured browser (YouTube, Google, Search)
 * 2. AUTOMATION_BROWSER: Uses browser automation for programmatic control
 *
 * Created by: Mr Amol Pandhre & the SARA Team
 */

import { spawn, execSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type BrowserType = "Chrome" | "Firefox" | "Edge" | "Safari" | "Default";
export type BrowserMode = "REAL_BROWSER" | "AUTOMATION_BROWSER";

export interface BrowserConfig {
  preferredBrowser: BrowserType;
  browserMode: BrowserMode;
  realBrowserEnabled: boolean;
  automationBrowserEnabled: boolean;
  defaultSearchEngine: string;
}

export interface BrowserInfo {
  type: BrowserType;
  executable?: string;
  isInstalled: boolean;
  version?: string;
}

// ─────────────────────────────────────────────────────────────────
// Browser Paths (Windows)
// ─────────────────────────────────────────────────────────────────

const BROWSER_EXECUTABLES: Record<BrowserType, string[]> = {
  Chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
  ],
  Firefox: [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    path.join(os.homedir(), "AppData\\Local\\Mozilla Firefox\\firefox.exe"),
  ],
  Edge: [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(os.homedir(), "AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe"),
  ],
  Safari: [
    "C:\\Program Files\\Safari\\Safari.exe", // Windows Safari (older)
  ],
  Default: ["start"], // Windows default browser
};

// ─────────────────────────────────────────────────────────────────
// Browser Manager
// ─────────────────────────────────────────────────────────────────

export class BrowserManager {
  private config: BrowserConfig;
  private projectRoot: string;
  private configFilePath: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.configFilePath = path.join(projectRoot, ".env.browser");
    this.config = this.loadConfig();
  }

  /**
   * Load browser configuration from .env.browser or return defaults
   */
  private loadConfig(): BrowserConfig {
    const defaults: BrowserConfig = {
      preferredBrowser: "Default",
      browserMode: "REAL_BROWSER",
      realBrowserEnabled: true,
      automationBrowserEnabled: true,
      defaultSearchEngine: "https://www.google.com/search?q=",
    };

    if (!fs.existsSync(this.configFilePath)) {
      return defaults;
    }

    try {
      const content = fs.readFileSync(this.configFilePath, "utf8");
      const config: Partial<BrowserConfig> = {};

      for (const line of content.split("\n")) {
        if (line.startsWith("PREFERRED_BROWSER=")) {
          const value = line.split("=")[1].trim() as BrowserType;
          if (["Chrome", "Firefox", "Edge", "Safari", "Default"].includes(value)) {
            config.preferredBrowser = value;
          }
        }
        if (line.startsWith("BROWSER_MODE=")) {
          const value = line.split("=")[1].trim() as BrowserMode;
          if (["REAL_BROWSER", "AUTOMATION_BROWSER"].includes(value)) {
            config.browserMode = value;
          }
        }
        if (line.startsWith("REAL_BROWSER_ENABLED=")) {
          config.realBrowserEnabled =
            line.split("=")[1].trim().toLowerCase() === "true";
        }
        if (line.startsWith("AUTOMATION_BROWSER_ENABLED=")) {
          config.automationBrowserEnabled =
            line.split("=")[1].trim().toLowerCase() === "true";
        }
      }

      return { ...defaults, ...config };
    } catch {
      return defaults;
    }
  }

  /**
   * Save configuration to .env.browser
   */
  saveConfig(): void {
    const content = `PREFERRED_BROWSER=${this.config.preferredBrowser}
BROWSER_MODE=${this.config.browserMode}
REAL_BROWSER_ENABLED=${this.config.realBrowserEnabled}
AUTOMATION_BROWSER_ENABLED=${this.config.automationBrowserEnabled}
`;

    fs.writeFileSync(this.configFilePath, content, "utf8");
  }

  /**
   * Get current configuration
   */
  getConfig(): BrowserConfig {
    return { ...this.config };
  }

  /**
   * Set preferred browser
   */
  setPreferredBrowser(browser: BrowserType): void {
    this.config.preferredBrowser = browser;
    this.saveConfig();
  }

  /**
   * Set browser mode (real vs automation)
   */
  setBrowserMode(mode: BrowserMode): void {
    this.config.browserMode = mode;
    this.saveConfig();
  }

  /**
   * Find installed browser executable
   */
  findBrowserExecutable(browserType: BrowserType): string | null {
    const paths = BROWSER_EXECUTABLES[browserType] || [];

    for (const browserPath of paths) {
      if (fs.existsSync(browserPath)) {
        return browserPath;
      }
    }

    // Try using 'where' command
    try {
      const executable =
        browserType === "Chrome"
          ? "chrome.exe"
          : browserType === "Firefox"
            ? "firefox.exe"
            : browserType === "Edge"
              ? "msedge.exe"
              : null;

      if (executable) {
        const result = execSync(`where ${executable}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        if (result) return result.split("\n")[0];
      }
    } catch {}

    return null;
  }

  /**
   * Get browser info
   */
  getBrowserInfo(browserType: BrowserType): BrowserInfo {
    const executable = this.findBrowserExecutable(browserType);
    return {
      type: browserType,
      executable: executable || undefined,
      isInstalled: !!executable,
    };
  }

  /**
   * Get all available browsers
   */
  getAvailableBrowsers(): BrowserInfo[] {
    const browsers: BrowserType[] = ["Chrome", "Firefox", "Edge", "Safari"];
    return browsers
      .map((b) => this.getBrowserInfo(b))
      .filter((b) => b.isInstalled);
  }

  /**
   * Open URL in real browser
   */
  openInBrowser(url: string, browserType?: BrowserType): boolean {
    try {
      const browser = browserType || this.config.preferredBrowser;
      const executable = this.findBrowserExecutable(browser);

      if (!executable) {
        console.warn(
          `[Browser] ${browser} not found. Falling back to default.`
        );
        execSync(`start ${url}`, { stdio: "ignore", shell: true });
        return true;
      }

      // Handle URL encoding and spaces
      const encodedUrl = url.replace(/"/g, '\\"');

      if (browser === "Default") {
        execSync(`start ${encodedUrl}`, {
          stdio: "ignore",
          shell: true,
        });
      } else {
        spawn(executable, [encodedUrl], {
          detached: true,
          stdio: "ignore",
        });
      }

      return true;
    } catch (e) {
      console.error(`[Browser] Failed to open URL: ${e}`);
      return false;
    }
  }

  /**
   * Search using default search engine
   */
  search(query: string): boolean {
    const searchUrl =
      this.config.defaultSearchEngine +
      encodeURIComponent(query);
    return this.openInBrowser(searchUrl);
  }

  /**
   * Open YouTube in real browser (preferred)
   */
  openYouTube(videoId?: string): boolean {
    const url = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : "https://www.youtube.com";
    return this.openInBrowser(url);
  }

  /**
   * Open Google in real browser (preferred)
   */
  openGoogle(): boolean {
    return this.openInBrowser("https://www.google.com");
  }

  /**
   * Determine if a request should use real browser or automation
   */
  shouldUseRealBrowser(command: string): boolean {
    const realBrowserCommands = [
      "youtube",
      "google",
      "search",
      "openwebsite",
      "openurl",
      "browseyoutube",
      "googlesearch",
    ];

    return (
      this.config.realBrowserEnabled &&
      this.config.browserMode === "REAL_BROWSER" &&
      realBrowserCommands.some((cmd) => command.toLowerCase().includes(cmd))
    );
  }

  /**
   * Get diagnostic report
   */
  getDiagnosticReport(): {
    config: BrowserConfig;
    availableBrowsers: BrowserInfo[];
    defaultBrowser: BrowserInfo | null;
  } {
    const availableBrowsers = this.getAvailableBrowsers();
    const defaultBrowser =
      availableBrowsers.find(
        (b) => b.type === this.config.preferredBrowser
      ) || availableBrowsers[0] || null;

    return {
      config: this.getConfig(),
      availableBrowsers,
      defaultBrowser,
    };
  }
}

export default BrowserManager;
