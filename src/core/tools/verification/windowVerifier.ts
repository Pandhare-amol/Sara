/**
 * Window/application verification for open/close/focus operations.
 * Delegates to the existing Python Desktop Agent window APIs.
 */

import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";

export interface WindowListResponse {
  windows: Array<{
    title: string;
    application_name: string;
    hwnd?: number;
    visible?: boolean;
  }>;
}

export interface ActiveWindowResponse {
  window: {
    title: string;
    application_name: string;
    hwnd?: number;
  };
}

export class WindowVerifier implements ToolVerifier {
  timeout = 2000;
  private desktopAgentUrl: string;

  constructor(desktopAgentUrl: string = "http://127.0.0.1:8765") {
    this.desktopAgentUrl = desktopAgentUrl;
  }

  canVerify(tool: string): boolean {
    return [
      "openApplication",
      "closeWindow",
      "focusWindow",
      "minimizeWindow",
      "maximizeWindow",
      "showApplication",
      "switchApplication",
    ].includes(tool);
  }

  async verify(
    tool: string,
    args: Record<string, unknown>,
    _executionResult: unknown,
  ): Promise<VerificationOutcome> {
    const checks = [];
    let passed = false;
    const observedState: Record<string, unknown> = {};

    try {
      const title = String(args.title || args.application || args.name || "").trim();
      if (!title) {
        return {
          verified: false,
          method: "window",
          checks: [
            {
              name: "missing_target_name",
              passed: false,
              reason: "No application name provided to verify",
            },
          ],
          details: "Cannot verify without a target application name",
          confidence: 0,
        };
      }

      // Get active window
      const activeRes = await fetch(
        `${this.desktopAgentUrl}/screen/live/windows`,
        { signal: AbortSignal.timeout(this.timeout) },
      );
      const activeData = (await activeRes.json()) as WindowListResponse;
      const windows = activeData?.windows || [];
      observedState.windows = windows;

      const matches = windows.filter(
        (w) =>
          title.toLowerCase().includes(w.application_name?.toLowerCase() || "") ||
          w.application_name?.toLowerCase().includes(title.toLowerCase() || "") ||
          w.title?.toLowerCase().includes(title.toLowerCase() || ""),
      );

      if (tool === "closeWindow") {
        passed = matches.length === 0;
        checks.push({
          name: "window_closed",
          passed,
          evidence: { remaining: matches.length },
        });
      } else if (["openApplication", "showApplication", "switchApplication"].includes(tool)) {
        passed = matches.length > 0;
        checks.push({
          name: "window_found",
          passed,
          evidence: { matches: matches.length, windows: matches },
        });
      } else if (tool === "focusWindow" || tool === "minimizeWindow" || tool === "maximizeWindow") {
        passed = matches.length > 0;
        checks.push({
          name: "window_accessible",
          passed,
          evidence: { matches: matches.length },
        });
      }
    } catch (error: any) {
      checks.push({
        name: "window_verification_error",
        passed: false,
        reason: String(error),
      });
    }

    return {
      verified: passed,
      method: "window",
      checks,
      details: passed
        ? `Window operation verified: ${tool}`
        : `Could not verify window state for ${tool}`,
      confidence: passed ? 0.9 : 0.2,
      observedState,
    };
  }
}
