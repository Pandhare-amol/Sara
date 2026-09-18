export type RecoveryActionType = "RETRY" | "FALLBACK_TOOL" | "RECHECK_CONTEXT" | "ASK_USER" | "DEGRADE_MODE";

export interface RecoveryContext {
  tool?: string;
  confirmed?: boolean;
  sandboxed?: boolean;
  source?: "user" | "model" | "recovery";
  riskLevel?: string;
}

export interface RecoveryFailure {
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface RecoveryPlan {
  action: RecoveryActionType;
  reason: string;
  confidence: number;
  fallbackTools?: string[];
  manualApprovalRequired?: boolean;
  maxAttempts?: number;
}

const FALLBACK_TOOL_MAP: Record<string, string[]> = {
  openWebsite: ["desktopBrowserOpen", "searchWeb"],
  searchWeb: ["openWebsite"],
  searchYouTube: ["openWebsite"],
  desktopBrowserOpen: ["openWebsite"],
  desktopBrowserSearch: ["searchWeb"],
  takeScreenshot: ["captureScreen"],
  captureScreen: ["takeScreenshot"],
  readFile: ["listFolder"],
  listFolder: ["readFile"],
};

export class RecoveryPolicyEngine {
  selectRecoveryPlan(tool: string, failure: RecoveryFailure, context: RecoveryContext = {}): RecoveryPlan | null {
    const message = `${failure.code || ""} ${failure.message || ""}`.toLowerCase();

    if (/permission|denied|confirmation|required/.test(message)) {
      return {
        action: "ASK_USER",
        reason: `User confirmation is required before retrying '${tool}'.`,
        confidence: 0.98,
        manualApprovalRequired: true,
      };
    }

    if (/sandbox|isolated|direct interpreter|shell|exec|eval|powershell|cmd|bash/.test(message)) {
      return {
        action: "ASK_USER",
        reason: `The tool requires a safe isolated execution path before it can proceed.`,
        confidence: 0.99,
        manualApprovalRequired: true,
      };
    }

    if (/timeout|network|unavailable|browser_timeout|econnreset|temporar|reset/.test(message)) {
      const fallbackTools = FALLBACK_TOOL_MAP[tool] || ["searchWeb", "openWebsite"];
      return {
        action: "FALLBACK_TOOL",
        reason: `Transient execution failure for '${tool}' suggests a fallback route is safer than retrying the same path.`,
        confidence: 0.87,
        fallbackTools,
        maxAttempts: 1,
      };
    }

    if (/not found|unknown tool|missing tool|not registered/.test(message)) {
      return {
        action: "RECHECK_CONTEXT",
        reason: `The system does not currently recognize '${tool}' in the active runtime context.`,
        confidence: 0.8,
      };
    }

    if (failure.retryable === true) {
      return {
        action: "RETRY",
        reason: `The failure appears transient; a bounded retry is appropriate for '${tool}'.`,
        confidence: 0.72,
        maxAttempts: 2,
      };
    }

    return null;
  }
}
