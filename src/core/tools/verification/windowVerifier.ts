/**
 * Window/application verification for open/close/focus operations.
 * Delegates to the existing Python Desktop Agent window APIs.
 */

import type { ToolVerifier, VerificationOutcome } from "./verificationRegistry";
import { getDesktopAgentAuthHeaders } from "../../../security/desktopAgentAuth";

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
  private readonly fetcher: typeof fetch;

  constructor(desktopAgentUrl: string = "http://127.0.0.1:8765", fetcher: typeof fetch = fetch) {
    this.desktopAgentUrl = desktopAgentUrl;
    this.fetcher = fetcher;
  }

  canVerify(tool: string): boolean {
    return [
      "openApplication",
      "closeApplication",
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
      const activeRes = await this.fetcher(
        `${this.desktopAgentUrl}/screen/live/windows`,
        {
          headers: getDesktopAgentAuthHeaders(this.desktopAgentUrl, process.env),
          signal: AbortSignal.timeout(this.timeout),
        },
      );
      if (!activeRes.ok) throw new Error(`Agent window query failed with HTTP ${activeRes.status}.`);
      const activeData = (await activeRes.json()) as WindowListResponse;
      const windows = activeData?.windows || [];
      observedState.windows = windows;

      const target = title.toLowerCase().replace(/\s+/g, " ").trim();
      const matches = windows.filter((window) => {
        const appName = String(window.application_name || "").toLowerCase().replace(/\s+/g, " ").trim();
        const windowTitle = String(window.title || "").toLowerCase().replace(/\s+/g, " ").trim();
        return Boolean(
          (appName && (appName === target || appName.includes(target) || target.includes(appName))) ||
          (windowTitle && (windowTitle === target || windowTitle.includes(target))),
        );
      });

      if (tool === "closeWindow" || tool === "closeApplication") {
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
