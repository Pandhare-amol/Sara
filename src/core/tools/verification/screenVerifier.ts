/**
 * Screen/browser verification for capture and browser operations.
 * Checks if screens can be captured and browsers are responding.
 */

import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";

export class ScreenVerifier implements ToolVerifier {
  timeout = 3000;
  private desktopAgentUrl: string;

  constructor(desktopAgentUrl: string = "http://127.0.0.1:8765") {
    this.desktopAgentUrl = desktopAgentUrl;
  }

  canVerify(tool: string): boolean {
    return [
      "captureScreen",
      "takeScreenshot",
      "screenCapture",
      "desktopBrowserOpen",
      "desktopBrowserSearch",
      "searchYouTube",
      "youtube_search",
      "youtube_play",
      "youtube_resume",
      "youtube_pause",
      "openWebsite",
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
      } else if (
        [
          "desktopBrowserOpen",
          "desktopBrowserSearch",
          "searchYouTube",
          "youtube_search",
          "youtube_play",
          "youtube_resume",
          "youtube_pause",
          "openWebsite",
        ].includes(tool)
      ) {
        passed = ["youtube_play", "youtube_resume", "youtube_pause"].includes(tool)
          ? await this.verifyMediaState(tool, checks, observedState)
          : await this.verifyBrowserState(checks, observedState);
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
    checks: any[],
    observedState: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      // Check if Desktop Agent browser APIs are responsive
      const response = await fetch(
        `${this.desktopAgentUrl}/screen/live/state`,
        { signal: AbortSignal.timeout(this.timeout) },
      );

      const available = response.ok;
      checks.push({
        name: "browser_api_responsive",
        passed: available,
        evidence: { status: response.status },
      });
      observedState.browserReady = available;

      return available;
    } catch (error) {
      checks.push({
        name: "browser_api_check_failed",
        passed: false,
        reason: String(error),
      });
      return false;
    }
  }

  private async verifyMediaState(
    tool: string,
    checks: any[],
    observedState: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${this.desktopAgentUrl}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
