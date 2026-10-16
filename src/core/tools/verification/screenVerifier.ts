/**
 * Screen/browser verification for capture and browser operations.
 * Checks if screens can be captured and browsers are responding.
 */

import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";
import { getDesktopAgentAuthHeaders } from "../../../security/desktopAgentAuth";

function normalizeQuery(value: unknown): string {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\+/g, " ").replace(/\s+/g, " ").trim();
}

function hostMatches(actual: string, expected: string): boolean {
  const host = actual.toLowerCase().replace(/^www\./, "");
  const domain = expected.toLowerCase().replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}

export class ScreenVerifier implements ToolVerifier {
  timeout = 3000;
  private desktopAgentUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(desktopAgentUrl: string = "http://127.0.0.1:8765", fetcher: typeof fetch = fetch) {
    this.desktopAgentUrl = desktopAgentUrl;
    this.fetcher = fetcher;
  }

  canVerify(tool: string): boolean {
    return [
      "captureScreen",
      "takeScreenshot",
      "screenCapture",
      "desktopBrowserOpen",
      "desktopBrowserSearch",
      "youtube_play",
      "youtube_resume",
      "youtube_pause",
    ].includes(tool);
  }

  async verify(
    tool: string,
    args: Record<string, unknown>,
    executionResult: unknown,
  ): Promise<VerificationOutcome> {
    const checks = [];
    let passed = false;
    const observedState: Record<string, unknown> = {};

    try {
      if (["captureScreen", "takeScreenshot", "screenCapture"].includes(tool)) {
        const canonical = executionResult && typeof executionResult === "object"
          ? executionResult as Record<string, any>
          : {};
        const payload = canonical.data && typeof canonical.data === "object"
          ? { ...canonical, ...canonical.data }
          : canonical;
        const captureEvidence = Boolean(
          payload.path || payload.image || payload.base64 || payload.image_base64 || payload.file ||
          (Number(payload.width) > 0 && Number(payload.height) > 0),
        );
        if (captureEvidence) {
          checks.push({
            name: "capture_execution_evidence",
            passed: true,
            evidence: { width: payload.width, height: payload.height, hasReference: Boolean(payload.path || payload.image || payload.base64 || payload.image_base64 || payload.file) },
          });
          observedState.imageAvailable = Boolean(payload.path || payload.image || payload.base64 || payload.image_base64 || payload.file);
          observedState.dimensions = { width: payload.width, height: payload.height };
          checks.push({
            name: "capture_dimensions_valid",
            passed: Number(payload.width) > 0 && Number(payload.height) > 0,
            evidence: { width: payload.width, height: payload.height },
          });
          observedState.screenshotId = payload.screenshot_id || payload.capture_id || null;
          observedState.dimensions = { width: Number(payload.width), height: Number(payload.height) };
          return {
            verified: Number(payload.width) > 0 && Number(payload.height) > 0,
            method: "screen",
            checks,
            details: "Screen capture artifact and dimensions verified.",
            confidence: 0.95,
            observedState,
          };
        }
        passed = await this.verifyScreenCapture(executionResult, checks, observedState);
      } else if (["youtube_play", "youtube_resume", "youtube_pause"].includes(tool)) {
        passed = await this.verifyMediaState(tool, checks, observedState);
      } else if (["desktopBrowserOpen", "desktopBrowserSearch"].includes(tool)) {
        passed = await this.verifyBrowserState(tool, args, checks, observedState);
      }
    } catch (error: any) {
      checks.push({
        name: "screen_verification_error",
        passed: false,
        reason: String(error),
      });
    }

    return {
      verified: passed,
      method: "screen",
      checks,
      details: passed
        ? `Screen operation verified: ${tool}`
        : `Could not verify screen state for ${tool}`,
      confidence: passed ? 0.85 : 0.3,
      observedState,
    };
  }

  private verifyScreenCapture(
    executionResult: unknown,
    checks: any[],
    observedState: Record<string, unknown>,
  ): boolean {
    const result = executionResult && typeof executionResult === "object" ? executionResult as Record<string, any> : {};
    const payload = result.data && typeof result.data === "object"
      ? { ...result, ...result.data }
      : result;

    // Check if image was captured
    const hasImage = !!(payload.path || payload.image || payload.base64 || payload.image_base64 || payload.file);
    checks.push({
      name: "image_captured",
      passed: hasImage,
      evidence: { hasImage },
    });
    observedState.imageAvailable = hasImage;

    // Check dimensions if available
    if (payload.width && payload.height) {
      const dimensionsValid = payload.width > 0 && payload.height > 0;
      checks.push({
        name: "image_dimensions_valid",
        passed: dimensionsValid,
        evidence: { width: payload.width, height: payload.height },
      });
      observedState.dimensions = { width: payload.width, height: payload.height };
    }

    return hasImage;
  }

  private async verifyBrowserState(
    tool: string,
    args: Record<string, unknown>,
    checks: any[],
    observedState: Record<string, unknown>,
  ): Promise<boolean> {
    let expectedHost = "";
    let expectedPath = "";
    let expectedQuery = "";
    try {
      if (tool === "desktopBrowserOpen") {
        let requestedUrl = String(args.url || "https://www.google.com").trim();
        if (!/^https?:\/\//i.test(requestedUrl)) requestedUrl = `https://${requestedUrl}`;
        const expected = new URL(requestedUrl);
        expectedHost = expected.hostname;
        expectedPath = expected.pathname.replace(/\/$/, "") || "/";
      } else {
        const engine = String(args.engine || "google").toLowerCase();
        const hostByEngine: Record<string, string> = {
          google: "google.com", youtube: "youtube.com", github: "github.com",
          duckduckgo: "duckduckgo.com", bing: "bing.com", amazon: "amazon.com",
          wikipedia: "wikipedia.org",
        };
        expectedHost = hostByEngine[engine] || "";
        expectedQuery = normalizeQuery(args.query || args.q);
        if (!expectedHost || !expectedQuery) throw new Error("Search verification requires a supported engine and query.");
      }
    } catch (error) {
      checks.push({ name: "browser_expected_target_valid", passed: false, reason: String(error) });
      return false;
    }

    const deadline = Date.now() + Math.min(this.timeout, 2000);
    let latestPages: Record<string, any>[] = [];
    let httpStatus: number | undefined;
    try {
      do {
        const response = await this.fetcher(`${this.desktopAgentUrl}/browser/state`, {
          headers: getDesktopAgentAuthHeaders(this.desktopAgentUrl, process.env),
          signal: AbortSignal.timeout(this.timeout),
        });
        httpStatus = response.status;
        if (!response.ok) break;
        const body = await response.json() as Record<string, any>;
        const states = body.states && typeof body.states === "object" ? Object.values(body.states) : [];
        latestPages = states.filter((state): state is Record<string, any> => Boolean(state && typeof state === "object"));
        const matchingPage = latestPages.find((page) => {
          if (page.ready !== true || page.navigation_state !== "complete") return false;
          try {
            const actual = new URL(String(page.url || ""));
            if (!hostMatches(actual.hostname, expectedHost)) return false;
            if (tool === "desktopBrowserOpen") {
              const actualPath = actual.pathname.replace(/\/$/, "") || "/";
              return expectedPath === "/" || actualPath === expectedPath;
            }
            const actualQuery = normalizeQuery(actual.searchParams.get("q") || actual.searchParams.get("search_query") || actual.searchParams.get("k") || actual.searchParams.get("query") || actual.searchParams.get("search"));
            return Boolean(actualQuery && actualQuery.includes(expectedQuery));
          } catch { return false; }
        });
        if (matchingPage) {
          checks.push({ name: "browser_api_responsive", passed: true, evidence: { status: httpStatus } });
          checks.push({ name: "browser_target_postcondition", passed: true, evidence: { expectedHost, expectedPath: expectedPath || undefined, expectedQuery: expectedQuery || undefined, actualUrl: matchingPage.url } });
          observedState.browserReady = true;
          observedState.page = matchingPage;
          return true;
        }
        if (Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      } while (Date.now() < deadline);

      checks.push({ name: "browser_api_responsive", passed: httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300, evidence: { status: httpStatus } });
      checks.push({ name: "browser_target_postcondition", passed: false, evidence: { expectedHost, expectedPath: expectedPath || undefined, expectedQuery: expectedQuery || undefined, pages: latestPages.map((page) => ({ url: page.url, ready: page.ready, navigationState: page.navigation_state })) }, reason: "No ready browser page matched the requested URL or search query." });
      observedState.browserReady = false;
      observedState.pages = latestPages;
      return false;
    } catch (error) {
      checks.push({ name: "browser_api_check_failed", passed: false, reason: String(error) });
      return false;
    }
  }

  private async verifyMediaState(
    tool: string,
    checks: any[],
    observedState: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.desktopAgentUrl}/execute`, {
        method: "POST",
        headers: getDesktopAgentAuthHeaders(this.desktopAgentUrl, process.env, "application/json"),
        body: JSON.stringify({ tool: "desktopBrowserMediaState", args: {} }),
        signal: AbortSignal.timeout(this.timeout),
      });
      const body = await response.json() as Record<string, any>;
      const state = (
        body.result?.media_state
        || body.result?.details?.raw_result?.media_state
        || body.result?.details?.raw_result?.result
        || body.result?.result
        || {}
      ) as Record<string, any>;
      const found = state.found === true;
      const ready = Number(state.readyState || 0) >= 2;
      const paused = state.paused === true;
      const expectedPlaying = tool !== "youtube_pause";
      const playbackMatches = expectedPlaying ? !paused && !state.ended : paused;
      const passed = response.ok && found && ready && playbackMatches;

      checks.push({
        name: "youtube_media_state",
        passed,
        evidence: { found, ready, paused, ended: state.ended, currentTime: state.currentTime },
        reason: passed ? undefined : `Expected ${expectedPlaying ? "playing" : "paused"} media state`,
      });
      observedState.media = state;
      return passed;
    } catch (error) {
      checks.push({
        name: "youtube_media_state_check_failed",
        passed: false,
        reason: String(error),
      });
      return false;
    }
  }
}
