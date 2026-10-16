import { randomBytes } from "node:crypto";
import { isLoopbackHost } from "./requestGuards";

export const DESKTOP_AGENT_AUTH_PROTOCOL_VERSION = 1;
const MINIMUM_TOKEN_BYTES = 32;

/** Generate a process-scoped secret if the supervisor has not supplied one. */
export function ensureDesktopAgentInternalToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.SARA_AGENT_INTERNAL_TOKEN || "").trim();
  if (configured && Buffer.byteLength(configured, "utf8") < MINIMUM_TOKEN_BYTES) {
    throw new Error("SARA_AGENT_INTERNAL_TOKEN must contain at least 32 UTF-8 bytes.");
  }

  const token = configured || randomBytes(MINIMUM_TOKEN_BYTES).toString("base64url");
  env.SARA_AGENT_INTERNAL_TOKEN = token;
  return token;
}

/**
 * Build headers for a Node-to-agent request. Loopback uses the private internal
 * token; non-loopback targets are HTTPS-only and require a remote-access token.
 */
export function getDesktopAgentAuthHeaders(
  agentUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  contentType?: string,
): Record<string, string> {
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch {
    throw new Error("DESKTOP_AGENT_URL must be a valid HTTP(S) URL.");
  }

  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("DESKTOP_AGENT_URL must not contain credentials and must use HTTP(S).");
  }

  const isLoopback = isLoopbackHost(url.hostname);
  if (!isLoopback && url.protocol !== "https:") {
    throw new Error("Remote desktop-agent connections require HTTPS.");
  }

  const token = isLoopback
    ? String(env.SARA_AGENT_INTERNAL_TOKEN || "")
    : String(env.SARA_AGENT_ACCESS_TOKEN || env.SARA_REMOTE_ACCESS_TOKEN || "");
  if (Buffer.byteLength(token, "utf8") < MINIMUM_TOKEN_BYTES) {
    throw new Error(isLoopback
      ? "SARA_AGENT_INTERNAL_TOKEN must contain at least 32 UTF-8 bytes."
      : "Remote desktop-agent access requires SARA_AGENT_ACCESS_TOKEN or SARA_REMOTE_ACCESS_TOKEN with at least 32 UTF-8 bytes.");
  }

  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "X-SARA-Agent-Token": token,
  };
}

export function hasAuthenticatedDesktopAgentProtocol(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  return health.agent_auth_required === true &&
    Number(health.agent_auth_protocol_version) === DESKTOP_AGENT_AUTH_PROTOCOL_VERSION;
}
