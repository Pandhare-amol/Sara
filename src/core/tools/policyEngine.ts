import type { ToolMetadata, ToolRegistry, ToolRiskLevel } from "./toolRegistry";

export type PolicyDecision = "ALLOW" | "ASK_USER" | "DENY";

export interface PolicyContext {
  context?: string;
  confirmed?: boolean;
  authorized?: boolean;
  allowedDomains?: string[];
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  reason: string;
  riskLevel: ToolRiskLevel;
  metadata?: ToolMetadata;
}

const PREPARATION_TOOLS = new Set(["requestPowerAction"]);

function hostnameFromArgs(args: Record<string, unknown>): string | undefined {
  const raw = typeof args.url === "string" ? args.url : typeof args.domain === "string" ? args.domain : undefined;
  if (!raw) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\*\./, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

/** Central deterministic gate for Gemini-proposed tool calls. */
export class ToolPolicyEngine {
  evaluate(tool: string, args: Record<string, unknown>, registry: ToolRegistry, context: PolicyContext = {}): PolicyOutcome {
    const metadata = registry.getMetadata(tool);
    if (!metadata) {
      return { decision: "DENY", reason: `Tool '${tool}' is not registered.`, riskLevel: "DESTRUCTIVE_SYSTEM" };
    }

    const hostname = hostnameFromArgs(args);
    if (hostname && context.allowedDomains && !isAllowedDomain(hostname, context.allowedDomains)) {
      return { decision: "DENY", reason: `Domain '${hostname}' is outside the allowed browser domain policy.`, riskLevel: metadata.riskLevel, metadata };
    }

    if (PREPARATION_TOOLS.has(tool)) {
      return { decision: "ALLOW", reason: "Confirmation preparation step.", riskLevel: metadata.riskLevel, metadata };
    }

    const explicitlyAuthorized = context.authorized === true || context.confirmed === true;
    const tokenConfirmed = tool === "executePowerAction" && typeof args.execute_token === "string" && args.execute_token.length > 0;
    if (metadata.riskLevel === "DESTRUCTIVE_SYSTEM" || metadata.requiresConfirmation) {
      if (!explicitlyAuthorized && !tokenConfirmed) {
        return { decision: "ASK_USER", reason: `Explicit confirmation is required before '${tool}'.`, riskLevel: metadata.riskLevel, metadata };
      }
    }

    if (metadata.riskLevel === "EXTERNAL_SIDE_EFFECT" && !explicitlyAuthorized) {
      return { decision: "ASK_USER", reason: `User confirmation is required before external side effect '${tool}'.`, riskLevel: metadata.riskLevel, metadata };
    }

    return { decision: "ALLOW", reason: "Tool is allowed by the current policy.", riskLevel: metadata.riskLevel, metadata };
  }
}
